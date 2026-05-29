import { FormEvent, useState } from "react";

export interface RepoConnectFormProps {
  defaultPath?: string;
  busy?: boolean;
  onConnect(repoPath: string): Promise<void>;
}

export function RepoConnectForm({ defaultPath = "", busy = false, onConnect }: RepoConnectFormProps) {
  const [repoPath, setRepoPath] = useState(defaultPath);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await onConnect(repoPath);
  }

  return (
    <form className="repo-connect" onSubmit={handleSubmit}>
      <label htmlFor="repo-path">Repository path</label>
      <div className="inline-form">
        <input
          id="repo-path"
          value={repoPath}
          onChange={(event) => setRepoPath(event.target.value)}
          placeholder="/path/to/repo"
        />
        <button type="submit" disabled={busy || !repoPath.trim()}>
          Connect
        </button>
      </div>
    </form>
  );
}
