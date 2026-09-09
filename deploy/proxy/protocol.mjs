// Pinned to T3 0.0.39 / Effect JSON RPC. Pings and subscriptions are not activity.
export function messages(data) {
  const parsed = JSON.parse(data.toString());
  return Array.isArray(parsed) ? parsed : [parsed];
}
export function subscription(m) {
  return m?._tag === 'Request' && (/^subscribe/.test(m.tag) || /\.subscribe/.test(m.tag) || m.tag === 'terminal.attach' || m.tag === 'orchestration.subscribe');
}
const actions = new Set([
  'terminal.write','terminal.open','terminal.clear','terminal.restart','terminal.close',
  'projects.writeFile','project.writeFile','vcs.pull','vcs.createWorktree','vcs.removeWorktree',
  'vcs.createRef','vcs.switchRef','vcs.init','git.runStackedAction','git.resolvePullRequest',
  'git.preparePullRequestThread','sourceControl.cloneRepository','sourceControl.publishRepository',
  'server.updateSettings','server.updateProvider','server.refreshProviders','server.signalProcess',
  'provider.auth.start','provider.auth.complete','provider.auth.cancel','provider.auth.logout',
  'provider.install.start','provider.install.cancel','provider.install.remove',
  'preview.open','preview.navigate','preview.refresh','preview.close',
  'orchestration.dispatchCommand',
]);
export function activity(m) {
  if (m?._tag !== 'Request' || typeof m.tag !== 'string') return false;
  if (m.tag === 'server.reportClientActivity') return m.payload?.recentlyInteracted === true;
  return actions.has(m.tag) || /^pullRequests\.(comment|updateComment|submitReview|replyToThread|setThreadResolution|setReaction|requestReviewers|setLabels|action)$/.test(m.tag);
}
export const cacheKey = m => JSON.stringify([m.tag, m.payload]);
export const failure = (id, message) => ({_tag:'Exit',requestId:id,exit:{_tag:'Failure',cause:[{_tag:'Die',defect:message}]}});
