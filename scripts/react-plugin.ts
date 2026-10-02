import react from "@vitejs/plugin-react";

/** Keep application and fixture transforms aligned; 0 is the A/B baseline. */
export default function reactPlugin() {
  return react({
    compiler:
      process.env.BUZZ_REACT_COMPILER === "0"
        ? false
        : { logDiagnostics: true },
  });
}
