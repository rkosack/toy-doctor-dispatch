// Writes the booked tech onto the RO once the customer arrives and the RO is opened.
//
// Rules (from the build spec):
// - Only ROs opened from an appointment that was assigned on the board.
// - Fills blanks only: if someone already set a tech in Tekmetric, that choice stands.
// - Sets the RO's technician, then any job on it that has no tech.
// - Happens once per RO. After that, Tekmetric is the source of truth.

export async function syncAssignments({ client, store, shopId, ros, log = console }) {
  const candidates = ros.filter((ro) => ro.appointmentId && !ro.deletedDate && ![3, 5, 6].includes(ro.repairOrderStatus?.id));
  if (!candidates.length) return [];
  const synced = await store.getSynced(candidates.map((ro) => ro.id));
  const pending = candidates.filter((ro) => !synced.has(ro.id));
  if (!pending.length) return [];
  const assignments = await store.getAssignments(shopId, pending.map((ro) => ro.appointmentId));
  const results = [];

  for (const ro of pending) {
    const a = assignments.get(ro.appointmentId);
    if (!a?.techId) continue;
    const result = { roId: ro.id, roNumber: ro.repairOrderNumber, techId: a.techId, roTech: 'kept', jobs: 0 };
    try {
      if (!ro.technicianId) {
        await client.patchRepairOrder(ro.id, { technicianId: a.techId });
        ro.technicianId = a.techId;
        result.roTech = 'set';
      }
      for (const job of ro.jobs ?? []) {
        if (job.technicianId || job.archived) continue;
        await client.patchJob(job.id, { technicianId: a.techId });
        job.technicianId = a.techId;
        result.jobs++;
      }
      await store.markSynced(ro.id, { techId: a.techId, appointmentId: ro.appointmentId, roTech: result.roTech, jobs: result.jobs, assignedBy: a.by ?? null });
      results.push(result);
    } catch (e) {
      log.error?.(`Could not set tech on RO ${ro.repairOrderNumber}: ${e.message}`); // tried again on the next refresh
    }
  }
  if (results.some((r) => r.roTech === 'set' || r.jobs)) client.clearCache();
  return results;
}

// Assigning an RO that's already open (e.g. one sitting in Unassigned): write it now.
export async function assignOpenRO({ client, ro, techId }) {
  await client.patchRepairOrder(ro.id, { technicianId: techId });
  let jobs = 0;
  for (const job of ro.jobs ?? []) {
    if (job.technicianId || job.archived) continue;
    await client.patchJob(job.id, { technicianId: techId });
    jobs++;
  }
  client.clearCache();
  return { roId: ro.id, jobs };
}
