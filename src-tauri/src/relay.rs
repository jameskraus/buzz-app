//! Packaged human relay access. Credentials stay with IdentityHost; redirects never carry auth.
use crate::identity::{EventTemplate, IdentityHost};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::OnceLock, time::Duration};
use url::Url;

type Result<T> = std::result::Result<T, String>;
const MAX_BODY: usize = 1024 * 1024;
const MAX_RESPONSE: usize = 16 * 1024 * 1024;

fn origin(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| "Invalid relay origin")?;
    if value.len() > 2048
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Relay access requires an HTTPS origin without credentials or a path".into());
    }
    Ok(url)
}

fn request_url(community: &str, path: &str, method: &str) -> Result<Url> {
    let allowed = match method {
        "GET" => matches!(path, "/" | "/api/join-policy"),
        "POST" => matches!(
            path,
            "/query" | "/events" | "/api/invites/claim" | "/api/invites/accept-policy"
        ),
        _ => false,
    };
    if !allowed {
        return Err("Unsupported relay request".into());
    }
    origin(community)?
        .join(path)
        .map_err(|_| "Invalid relay path".into())
}

#[tauri::command]
pub(crate) async fn relay_sign(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    event: EventTemplate,
) -> Result<serde_json::Value> {
    validate_event(&community, &event)?;
    host.sign(event).await
}

fn validate_event(community: &str, event: &EventTemplate) -> Result<()> {
    let mut relay = origin(community)?;
    if event.kind == 22242 {
        relay.set_scheme("wss").map_err(|_| "Invalid relay")?;
        let relay_tags: Vec<_> = event
            .tags
            .iter()
            .filter(|t| t.first().map(String::as_str) == Some("relay"))
            .collect();
        let challenges: Vec<_> = event
            .tags
            .iter()
            .filter(|t| t.first().map(String::as_str) == Some("challenge"))
            .collect();
        if !event.content.is_empty()
            || event.tags.len() != 2
            || relay_tags.len() != 1
            || relay_tags[0].len() != 2
            || Url::parse(&relay_tags[0][1]).ok().as_ref() != Some(&relay)
            || challenges.len() != 1
            || challenges[0].len() != 2
            || challenges[0][1].is_empty()
            || challenges[0][1].len() > 4096
        {
            return Err("Relay authentication does not match this community".into());
        }
    } else if event.kind == 28936 {
        // A NIP-43 leave request revokes the signer's own membership: empty
        // content and exactly the NIP-70 protected tag, nothing else.
        if !event.content.is_empty() || event.tags != vec![vec!["-".to_string()]] {
            return Err("A leave request carries no content or other tags".into());
        }
    } else if !matches!(
        event.kind,
        0 | 7 | 9 | 1984 | 9000 | 9001 | 20001 | 30315 | 40003 | 40100 | 42000
    ) {
        return Err("This event is not supported by the packaged relay connection".into());
    }
    Ok(())
}

#[derive(Serialize)]
pub(crate) struct RelayResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
}

fn client() -> Result<&'static reqwest::Client> {
    static CLIENT: OnceLock<std::result::Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
        })
        .as_ref()
        .map_err(|_| "Relay network client is unavailable".into())
}

#[tauri::command]
pub(crate) async fn relay_http(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    path: String,
    method: String,
    body: Option<String>,
) -> Result<RelayResponse> {
    let url = request_url(&community, &path, &method)?;
    if body.as_ref().is_some_and(|b| b.len() > MAX_BODY)
        || (method == "GET" && body.is_some())
        || (method == "POST" && body.is_none())
    {
        return Err("Invalid relay request body".into());
    }
    send(host.inner(), url, &method, body).await
}

async fn send(
    host: &IdentityHost,
    url: Url,
    method: &str,
    body: Option<String>,
) -> Result<RelayResponse> {
    let mut request = client()?.request(
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid relay method")?,
        url.clone(),
    );
    if let Some(body) = body {
        let auth = host
            .sign(EventTemplate {
                kind: 27235,
                created_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| "System clock is unavailable")?
                    .as_secs(),
                content: String::new(),
                tags: vec![
                    vec!["u".into(), url.to_string()],
                    vec!["method".into(), method.into()],
                    vec![
                        "payload".into(),
                        format!("{:x}", Sha256::digest(body.as_bytes())),
                    ],
                    vec!["nonce".into(), uuid::Uuid::new_v4().to_string()],
                ],
            })
            .await?;
        request = request
            .header(
                "Authorization",
                format!(
                    "Nostr {}",
                    STANDARD.encode(
                        serde_json::to_vec(&auth)
                            .map_err(|_| "Could not encode relay authentication")?
                    )
                ),
            )
            .header("Content-Type", "application/json")
            .body(body);
    } else {
        request = request.header("Accept", "application/nostr+json");
    }
    // Never replay a write after a transport error: it may already have reached the relay.
    let mut response = request
        .send()
        .await
        .map_err(|_| "Relay request could not be confirmed")?;
    let status = response.status().as_u16();
    let mut headers = BTreeMap::new();
    for name in ["content-type", "retry-after", "server-timing"] {
        if let Some(value) = response.headers().get(name).and_then(|v| v.to_str().ok()) {
            headers.insert(name.into(), value.into());
        }
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Relay response was interrupted")?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("Relay response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| "Relay response is not UTF-8")?;
    Ok(RelayResponse {
        status,
        headers,
        body,
    })
}

#[cfg(test)]
mod tests;
