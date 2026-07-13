function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function submittedAfter(stage, baseline) {
  const submitted = timestamp(stage?.submittedAt);
  return submitted > 0 && (!baseline || submitted >= baseline);
}

export function resolveEmployeeStageState(submission = null, stages = {}, published = false) {
  const workflowStatus = String(submission?.status || '').trim();

  if (published) {
    return {
      stageId: 'completed',
      selfDone: true,
      managerDone: true,
      hodDone: true,
      finalDone: true,
    };
  }

  if (workflowStatus && workflowStatus !== 'approved') {
    return {
      stageId: workflowStatus === 'pending-manager' ? 'pending-approval' : 'goal-creation',
      selfDone: false,
      managerDone: false,
      hodDone: false,
      finalDone: false,
    };
  }

  const approvalAt = Math.max(
    timestamp(submission?.approvedAt),
    timestamp(submission?.managerDecisionAt),
  );
  const selfDone = submittedAfter(stages?.self, approvalAt);
  const selfSubmittedAt = timestamp(stages?.self?.submittedAt);
  const managerDone = selfDone && submittedAfter(stages?.manager, selfSubmittedAt);
  const managerSubmittedAt = timestamp(stages?.manager?.submittedAt);
  const hodAt = Math.max(
    timestamp(stages?.hod?.submittedAt),
    timestamp(stages?.hod?.calibratedAt),
  );
  const hodDone = managerDone
    && hodAt > 0
    && (!managerSubmittedAt || hodAt >= managerSubmittedAt)
    && Number.isFinite(Number(stages?.hod?.calibratedScore));
  const finalAt = Math.max(
    timestamp(stages?.final?.submittedAt),
    timestamp(stages?.final?.calibratedAt),
  );
  const finalDone = managerDone
    && finalAt > 0
    && (!managerSubmittedAt || finalAt >= managerSubmittedAt)
    && Number.isFinite(Number(stages?.final?.calibratedScore));

  return {
    stageId: finalDone
      ? 'calibrated'
      : managerDone
        ? 'hr-review'
        : selfDone
          ? 'mgr-evaluation'
          : 'self-evaluation',
    selfDone,
    managerDone,
    hodDone,
    finalDone,
  };
}
