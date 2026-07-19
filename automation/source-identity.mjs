const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function join(parts) {
  return parts.map(clean).filter(Boolean).join("; ");
}

export function observedSourceIdentity(event, { artifactId = "" } = {}) {
  const snapshot = event?.snapshot || {};
  const papers = array(snapshot.papers).filter((paper) => paper?.id);
  if (artifactId) {
    const paper = papers.find((candidate) => candidate.id === artifactId);
    if (paper) return `arxiv:${paper.id}v${paper.version || "?"}`;
  }
  if (snapshot.revision_sha) {
    return join([
      `${snapshot.artifact_kind || "artifact"}:${snapshot.artifact_id || event?.latest_item_title || "unknown"}`,
      `revision:${snapshot.revision_sha}`,
      snapshot.license ? `license:${snapshot.license}` : "",
      Number.isFinite(snapshot.file_count) ? `files:${snapshot.file_count}` : "",
    ]);
  }
  const commits = array(snapshot.commits).filter((commit) => commit?.sha);
  if (commits.length) return join([`git-commit:${commits[0].sha}`, snapshot.commit_scope ? `scope:${snapshot.commit_scope}` : ""]);
  if (snapshot.blob_sha) return join([`git-blob:${snapshot.blob_sha}`, snapshot.path ? `path:${snapshot.path}` : ""]);
  if (snapshot.head_sha) {
    const trackedFiles = array(snapshot.tracked_files).filter((file) => file?.path);
    return join([
      `git-tree:${snapshot.head_sha}`,
      snapshot.tracked_sha ? `tracked-blob:${snapshot.tracked_sha}` : "",
      snapshot.tracked_path ? `path:${snapshot.tracked_path}` : "",
      ...trackedFiles.slice(0, 12).map((file) => `${file.present === false ? "missing" : "tracked"}:${file.path}@${file.sha || "?"}`),
    ]);
  }
  if (snapshot.normalized_text_sha256) return `document-sha256:${snapshot.normalized_text_sha256}`;
  const releases = array(snapshot.releases).filter((release) => release?.id || release?.tag_name);
  if (releases.length) {
    const release = snapshot.latest_stable?.id || snapshot.latest_stable?.tag_name ? snapshot.latest_stable : releases[0];
    return join([
      `github-release-snapshot:${release.repository || "unknown/unknown"}@${release.release_snapshot_sha256 || release.semantic_payload_sha256 || release.body_sha256 || release.id || "unknown"}`,
      `release-id:${release.id || "unknown"}`,
      `tag:${release.tag_name || "unknown"}`,
      release.target_commitish ? `target:${release.target_commitish}` : "",
      `upstream-immutable:${release.immutable === true}`,
    ]);
  }
  if (papers.length) return papers.map((paper) => `arxiv:${paper.id}v${paper.version || "?"}`).join(", ");
  if (snapshot.latest_id) return `feed-item:${clean(snapshot.latest_id)}`;
  if (event?.content_sha256) return `response-sha256:${event.content_sha256}`;
  return "unavailable";
}
