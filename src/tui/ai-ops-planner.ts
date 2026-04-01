export interface AIOpsPlan {
  title: string;
  risk: 'low' | 'medium' | 'high';
  actionLabels: string[];
  notes: string[];
  typedApprovalPhrase?: string;
}

const AI_OPS_HIGH_RISK_APPROVAL_PHRASE = 'AI OPS APPROVED';

export function inferAIOpsPlan(intent: string): AIOpsPlan {
  const normalized = intent.trim().toLowerCase();
  const notes: string[] = [];
  const actionLabels: string[] = [];
  let title = 'General system check';
  let risk: 'low' | 'medium' | 'high' = 'low';

  if (/\bstuck queue\b|\bqueue stuck\b|\bqueue not\b|\bjobs?\b.*\bnot processing\b/.test(normalized)) {
    title = 'Queue recovery plan';
    risk = 'medium';
    actionLabels.push('Quick Fix: Recover Stuck Queue');
    notes.push('Will restart queue workers and clear optimize cache.');
  } else if (/\bservice\b.*\bdown\b|\bservice\b.*\bunhealthy\b|\bcontainer\b.*\bunhealthy\b|\brestart service\b|\b500\b/.test(normalized)) {
    title = 'Service triage plan';
    risk = 'medium';
    actionLabels.push('Quick Fix: Triage Unhealthy Service');
    notes.push('Will capture logs and restart unhealthy services.');
  } else if (/\bbuild failed\b|\bbranch failed\b|\bpipeline failed\b|\bcannot build\b/.test(normalized)) {
    title = 'Build failure triage plan';
    risk = 'low';
    actionLabels.push('Quick Fix: Triage Branch Build Failure');
    notes.push('Will run branch compare + doctor checks before retry.');
  } else if (/\bpromote\b|\brelease to\b|\bdeploy to\b|\bopen pr\b/.test(normalized)) {
    title = 'Release promotion plan';
    risk = 'high';
    actionLabels.push('Release Cockpit: Promote Branch (Create PR)');
    notes.push('Creates pull request after gate checks.');
  } else if (/\bcompare branch\b|\bdiff branch\b|\bahead behind\b|\bbranch compare\b/.test(normalized)) {
    title = 'Branch comparison plan';
    risk = 'low';
    actionLabels.push('Release Cockpit: Compare Branches');
  } else if (/\bdocker logs\b|\bfollow logs\b|\bcontainer logs\b/.test(normalized)) {
    title = 'Docker log follow plan';
    risk = 'low';
    actionLabels.push('Monitor: Docker Logs Follow/Filter');
  } else if (/\bdoctor\b|\bcheck prerequisites\b|\bhealth check\b/.test(normalized)) {
    title = 'System doctor plan';
    risk = 'low';
    actionLabels.push('System Doctor: Check Prerequisites');
  } else if (/\bbackup\b|\brestore\b/.test(normalized)) {
    title = 'Backup operations plan';
    risk = 'low';
    actionLabels.push('Backup: List Backups');
    notes.push('List existing backups, then create or restore as needed.');
  } else if (/\bcreate instance\b|\bnew instance\b|\bprovision\b/.test(normalized)) {
    title = 'Instance provisioning plan';
    risk = 'low';
    actionLabels.push('MCP Passthrough: Create Instance');
    notes.push('Will prompt for branch and configuration details.');
  } else if (/\bremove instance\b|\bdelete instance\b|\bteardown\b/.test(normalized)) {
    title = 'Instance removal plan';
    risk = 'high';
    actionLabels.push('MCP Passthrough: Remove Instance');
    notes.push('Will prompt for instance prefix and confirmation.');
  } else {
    actionLabels.push('System Doctor: Check Prerequisites');
    notes.push('Fallback plan: doctor check for general overview.');
  }

  return {
    title,
    risk,
    actionLabels,
    notes,
    typedApprovalPhrase: risk === 'high' ? AI_OPS_HIGH_RISK_APPROVAL_PHRASE : undefined,
  };
}

export function fuzzyMatchActions(query: string, labels: string[]): string[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return labels;
  return labels.filter(label => {
    const lower = label.toLowerCase();
    return words.every(word => lower.includes(word));
  });
}
