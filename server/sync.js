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
    if (!a?.techId && !a?.advisorId) continue;
    const result = { roId: ro.id, roNumber: ro.repairOrderNumber, techId: a.techId ?? null, roTech: 'kept', jobs: 0, advisor: 'kept' };
    try {
      // the advisor picked on the board becomes the RO's service writer, if it has none
      if (a.advisorId && !ro.serviceWriterId) {
        await client.patchRepairOrder(ro.id, { serviceWriterId: a.advisorId });
        ro.serviceWriterId = a.advisorId;
        result.advisor = 'set';
      }
      if (!a.techId) { await store.markSynced(ro.id, { techId: null, advisorId: a.advisorId, appointmentId: ro.appointmentId, advisor: result.advisor, assignedBy: a.by ?? null }); results.push(result); continue; }
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
      await store.markSynced(ro.id, { techId: a.techId, advisorId: a.advisorId ?? null, appointmentId: ro.appointmentId, roTech: result.roTech, jobs: result.jobs, advisor: result.advisor, assignedBy: a.by ?? null });
      results.push(result);
    } catch (e) {
      log.error?.(`Could not set tech on RO ${ro.repairOrderNumber}: ${e.message}`); // tried again on the next refresh
    }
  }
  if (results.some((r) => r.roTech === 'set' || r.jobs || r.advisor === 'set')) client.clearCache();
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

// Moving an RO's work from one tech to another on the board (drag or the card's dialog).
// Moves the jobs that tech has on the RO (jobs with no tech count as the RO's tech), and the RO's own
// technician if it was that tech. Other techs' jobs on the same RO stay as they are.
export async function reassignRO({ client, ro, fromTechId, toTechId }) {
  if (fromTechId === toTechId) return { roId: ro.id, jobs: 0, roTech: 'kept' };
  const roTechWasFrom = ro.technicianId === fromTechId;
  let jobs = 0;
  for (const job of ro.jobs ?? []) {
    if (job.archived) continue;
    if ((job.technicianId ?? ro.technicianId) !== fromTechId) continue;
    await client.patchJob(job.id, { technicianId: toTechId });
    jobs++;
  }
  if (roTechWasFrom) await client.patchRepairOrder(ro.id, { technicianId: toTechId });
  client.clearCache();
  return { roId: ro.id, jobs, roTech: roTechWasFrom ? 'set' : 'kept' };
}
