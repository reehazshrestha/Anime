/** Runtime paths and environment for the server. */
import { statSync } from "node:fs";
import os from "node:os";

function splitPath(p: string | undefined): string[] {
  return (p ?? "").split(":").filter(Boolean);
}

export const runtimeConfig = {
  /** PATH as seen by spawned processes, plus common local bin dirs. */
  pathEnv: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  pathDirs: [
    ...splitPath(process.env.PATH),
    `${os.homedir()}/.local/bin`,
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ],
  /** ani-cli binary name or absolute path. */
  aniCliBin: process.env.ANISTREAM_ANI_CLI ?? "ani-cli",
  /** Server port. */
  port: Number(process.env.PORT ?? 8787),
  /** Browser UA used by the scraper, mirrors ani-cli's agent. */
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

export function findExecutable(name: string): string | null {
  for (const dir of runtimeConfig.pathDirs) {
    if (!dir) continue;
    const candidate = `${dir}/${name}`;
    try {
      const st = statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}
