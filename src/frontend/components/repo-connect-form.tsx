import { FormEvent, useEffect, useState } from "react";

export interface RepoConnectFormProps {
  defaultPath?: string;
  recentPaths?: string[];
  busy?: boolean;
  onConnect(repoPath: string): Promise<void>;
}

export function RepoConnectForm({
  defaultPath = "",
  recentPaths = [],
  busy = false,
  onConnect
}: RepoConnectFormProps) {
  const [repoPath, setRepoPath] = useState(defaultPath);

  useEffect(() => {
    if (defaultPath) {
      setRepoPath(defaultPath);
    }
  }, [defaultPath]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await onConnect(repoPath);
  }

  return (
    <form className="repo-connect" onSubmit={handleSubmit}>
      <div className={recentPaths.length > 0 ? "inline-form has-recent-paths" : "inline-form"}>
        <input
          aria-label="Repository path"
          id="repo-path"
          value={repoPath}
          onChange={(event) => setRepoPath(event.target.value)}
          placeholder="/path/to/repo"
        />
        {recentPaths.length > 0 ? (
          <select
            aria-label="Recent repositories"
            className="repo-recent-select"
            value=""
            onChange={(event) => {
              if (event.target.value) {
                setRepoPath(event.target.value);
              }
            }}
          >
            <option value="">Recent</option>
            {recentPaths.map((path) => (
              <option key={path} value={path}>{path}</option>
            ))}
          </select>
        ) : null}
        <button type="submit" disabled={busy || !repoPath.trim()}>
          Connect
        </button>
      </div>
    </form>
  );
}
