//! Generic, native-owned launch protection. Provider code and policy schemas are external.
use crate::{config::Agent, runtime::Controller, store::Document, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Command,
};

const KEY: &str = "launchProtection";
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub provider: String,
    pub policy: Value,
}
#[derive(Clone)]
pub(crate) struct Provider {
    executable: PathBuf,
    digest: Vec<u8>,
    lease: String,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Snapshot,
    Register {
        provider: String,
        executable: PathBuf,
    },
    Unregister {
        provider: String,
        lease: String,
    },
    Defaults {
        revision: u64,
        binding: Option<Binding>,
    },
    Agent {
        id: String,
        revision: u64,
        binding: Option<Binding>,
    },
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
}
fn validate(binding: &Option<Binding>) -> Result<()> {
    if let Some(b) = binding {
        if !valid_id(&b.provider)
            || !b.policy.is_object()
            || serde_json::to_vec(&b.policy)
                .map_err(|_| "Invalid protection policy")?
                .len()
                > 32 * 1024
        {
            return Err("Invalid or oversized protection policy".into());
        }
    }
    Ok(())
}
pub(crate) fn defaults(doc: &Document) -> Result<Option<Binding>> {
    decode(doc.extra.get(KEY))
}
fn decode(value: Option<&Value>) -> Result<Option<Binding>> {
    let binding = serde_json::from_value(value.cloned().unwrap_or(Value::Null))
        .map_err(|_| "Saved protection is malformed; launch refused")?;
    validate(&binding)?;
    Ok(binding)
}
fn revision(doc: &Document) -> Result<u64> {
    match doc.extra.get("launchProtectionRevision") {
        None => Ok(0),
        Some(v) => v.as_u64().ok_or("Invalid protection revision".into()),
    }
}
fn executable_digest(path: &Path) -> Result<Vec<u8>> {
    if !path.is_absolute() {
        return Err("Choose an absolute protection launcher path".into());
    }
    let meta = std::fs::symlink_metadata(path).map_err(|_| "Protection launcher is unavailable")?;
    if !meta.is_file() || meta.len() > 256 * 1024 * 1024 {
        return Err("Protection launcher must be a bounded regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return Err("Protection launcher is not executable".into());
        }
    }
    Ok(
        Sha256::digest(std::fs::read(path).map_err(|_| "Cannot read protection launcher")?)
            .to_vec(),
    )
}
impl Controller {
    pub fn protect_control_paths(&mut self, paths: Result<Vec<PathBuf>>) {
        self.protection_paths = paths;
    }

    pub fn security(&mut self, request: Request) -> Result<Value> {
        match request {
            Request::Snapshot => self.security_snapshot(),
            Request::Register {
                provider,
                executable,
            } => {
                if !valid_id(&provider) {
                    return Err("Invalid protection provider".into());
                }
                let digest = executable_digest(&executable)?;
                let mut bytes = [0u8; 24];
                getrandom::fill(&mut bytes).map_err(|_| "Cannot create provider lease")?;
                let lease: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                self.security_providers.insert(
                    provider,
                    Provider {
                        executable,
                        digest,
                        lease: lease.clone(),
                    },
                );
                Ok(json!({"lease": lease}))
            }
            Request::Unregister { provider, lease } => {
                if self
                    .security_providers
                    .get(&provider)
                    .is_some_and(|p| p.lease == lease)
                {
                    self.security_providers.remove(&provider);
                }
                self.security_snapshot()
            }
            Request::Defaults {
                revision: expected,
                binding,
            } => {
                validate(&binding)?;
                self.require_provider(&binding)?;
                let mut doc = self.store.read()?;
                if revision(&doc)? != expected {
                    return Err("Protection defaults changed; reload before saving".into());
                }
                doc.extra.insert(
                    KEY.into(),
                    serde_json::to_value(binding).map_err(|_| "Invalid defaults")?,
                );
                doc.extra.insert(
                    "launchProtectionRevision".into(),
                    json!(expected.checked_add(1).ok_or("Revision exhausted")?),
                );
                self.store.write(&doc)?;
                self.security_snapshot()
            }
            Request::Agent {
                id,
                revision: expected,
                binding,
            } => {
                validate(&binding)?;
                self.require_provider(&binding)?;
                let mut doc = self.store.read()?;
                let agent = doc
                    .agents
                    .iter_mut()
                    .find(|a| a.id == id)
                    .ok_or("Agent no longer exists")?;
                if agent.revision != expected {
                    return Err("Agent changed; reload before saving protection".into());
                }
                agent.extra.insert(
                    KEY.into(),
                    serde_json::to_value(binding).map_err(|_| "Invalid protection")?,
                );
                agent.revision = agent.revision.checked_add(1).ok_or("Revision exhausted")?;
                self.store.write(&doc)?;
                self.security_snapshot()
            }
        }
    }
    fn require_provider(&self, binding: &Option<Binding>) -> Result<()> {
        if binding
            .as_ref()
            .is_some_and(|b| !self.security_providers.contains_key(&b.provider))
        {
            return Err("Enable the protection provider before saving".into());
        }
        Ok(())
    }
    fn security_snapshot(&self) -> Result<Value> {
        let doc = self.store.read()?;
        let agents = doc
            .agents
            .iter()
            .map(|a| Ok(json!({"id": a.id, "binding": decode(a.extra.get(KEY))?})))
            .collect::<Result<Vec<_>>>()?;
        Ok(
            json!({"revision": revision(&doc)?, "defaults": defaults(&doc)?, "agents": agents,
            "availableProviders": self.security_providers.keys().collect::<Vec<_>>() }),
        )
    }
    pub fn security_restore_ids(&mut self, provider: &str) -> Result<Vec<String>> {
        let running: Vec<_> = self
            .snapshot()?
            .agents
            .into_iter()
            .filter(|a| a.status == crate::ProcessStatus::Running)
            .map(|a| a.id)
            .collect();
        Ok(self
            .store
            .agents()?
            .iter()
            .filter(|a| a.starts_on_launch() && !running.contains(&a.id))
            .filter_map(|a| {
                decode(a.extra.get(KEY))
                    .ok()
                    .flatten()
                    .filter(|b| b.provider == provider)
                    .map(|_| a.id.clone())
            })
            .collect())
    }
    pub(crate) fn wrap_protected_worker(
        &self,
        agent: &Agent,
        command: &mut Command,
        temporary: &Path,
    ) -> Result<()> {
        let Some(binding) = decode(agent.extra.get(KEY))? else {
            return Ok(());
        };
        let provider = self
            .security_providers
            .get(&binding.provider)
            .ok_or("Required security plugin is unavailable; agent was not started")?;
        if executable_digest(&provider.executable)? != provider.digest {
            return Err("Protection launcher changed; re-enable the plugin before starting".into());
        }
        let env: BTreeMap<_, _> = command
            .get_envs()
            .filter_map(|(k, v)| {
                v.map(|v| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect();
        let worker = env
            .get("BUZZ_ACP_AGENT_COMMAND")
            .ok_or("Missing worker executable")?;
        let args = env.get("BUZZ_ACP_AGENT_ARGS").cloned().unwrap_or_default();
        // The provider gets a fixed launch description, not a callback into the host.
        // Values can contain commas: they live in a private JSON file, never ACP's comma-separated args.
        let mut protected_paths = self.protection_paths.clone()?;
        protected_paths.push(self.store.root().to_path_buf());
        protected_paths.push(
            provider
                .executable
                .parent()
                .ok_or("Invalid protection launcher")?
                .to_path_buf(),
        );
        protected_paths.push(temporary.to_path_buf());
        if let Ok(bundle) = &self.bundle {
            protected_paths.push(bundle.directory.clone());
        }
        protected_paths.push(std::env::current_exe().map_err(|_| "Cannot locate host executable")?);
        let context = json!({"version":1,"worker":worker,"args":args.split(',').filter(|s| !s.is_empty()).collect::<Vec<_>>(),
            "policy":binding.policy,"relayUrl":agent.relay_url,"workspace":agent.workspace,
            "protectedPaths":protected_paths});
        let path = temporary.join("launch-protection.json");
        if path.to_string_lossy().contains(',') {
            return Err("Protection launch path cannot contain commas".into());
        }
        let mut file = std::fs::OpenOptions::new();
        file.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            file.mode(0o400);
        }
        use std::io::Write;
        file.open(&path)
            .and_then(|mut f| f.write_all(&serde_json::to_vec(&context)?))
            .map_err(|_| "Cannot create private protection launch snapshot")?;
        command
            .env("BUZZ_ACP_AGENT_COMMAND", &provider.executable)
            .env(
                "BUZZ_ACP_AGENT_ARGS",
                format!("--launch,{}", path.display()),
            );
        Ok(())
    }
}
