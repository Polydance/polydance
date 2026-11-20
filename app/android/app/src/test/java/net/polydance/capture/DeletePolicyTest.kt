package net.polydance.capture

import org.junit.Assert.*
import org.junit.Test

class DeletePolicyTest {
    private val owner = DeletePolicy.Owner("https://receiver.example", "meta:alice")
    private val clientId = "device-run"
    private fun admitted() = DeletePolicy.beforeCreate(DeletePolicy.Entry(), clientId, owner)!!

    @Test fun deleteBeforeCreateBlocksInitialAndRetryAdmission() {
        val deleted = DeletePolicy.request(DeletePolicy.Entry())
        assertFalse(deleted.pending) // No admitted POST or remote copy.
        assertFalse(DeletePolicy.mayUpload(deleted))
        assertNull(DeletePolicy.beforeCreate(deleted, clientId, owner))
        assertNull(DeletePolicy.beforeCreate(deleted, clientId, owner.copy(account = "meta:bob")))
    }

    @Test fun deleteDuringPostKeepsLateIdentityAndNeverAuthorizesContent() {
        val pending = DeletePolicy.request(admitted())
        assertTrue(pending.pending)
        val late = DeletePolicy.created(pending, clientId, owner, "remote-id")
        assertEquals(setOf("remote-id"), late.targets.single().ids)
        assertEquals(0, late.targets.single().outstandingCreates)
        assertTrue(late.pending)
        assertFalse(DeletePolicy.mayUpload(late))
        assertNull(DeletePolicy.beforeCreate(late, clientId, owner))
    }

    @Test fun createBeforeDeleteHasTheSameDurableRemoteTarget() {
        val created = DeletePolicy.created(admitted(), clientId, owner, "remote-id")
        val pending = DeletePolicy.request(created)
        assertEquals(setOf("remote-id"), pending.targets.single().ids)
        val done = DeletePolicy.confirm(pending, pending.targets.single())
        assertFalse(done.pending)
        assertTrue(done.deleted)
        assertFalse(DeletePolicy.mayUpload(done)) // Tombstone is never removed on success.
    }

    @Test fun lostResponseCanRecoverWithoutRecordingFilesButAbsenceIsNotSuccess() {
        // Reconstruct only journal state, as after process death: no file/UploadState dependency.
        val saved = DeletePolicy.request(admitted())
        val restored = DeletePolicy.Entry(saved.deleted, saved.targets.map { it.copy(ids = it.ids.toSet()) })
        val target = restored.targets.single()
        val empty = DeletePolicy.recover(target, emptySet())
        assertTrue(DeletePolicy.confirm(DeletePolicy.replace(restored, empty), empty).pending)
        val recovered = DeletePolicy.recover(target, setOf("recovered-id"))
        assertEquals(setOf("recovered-id"), recovered.ids)
        assertEquals(owner, recovered.owner)
        // The recovered ID can be deleted, but another admitted request might still arrive later.
        assertTrue(DeletePolicy.confirm(DeletePolicy.replace(restored, recovered), recovered).pending)
        assertFalse(DeletePolicy.mayUpload(restored))
    }

    @Test fun originalServerAndAccountMustBothMatchAndUnknownIsNeverOwned() {
        val target = admitted().targets.single()
        assertTrue(DeletePolicy.owns(target, owner))
        assertFalse(DeletePolicy.owns(target, owner.copy(server = "https://other.example")))
        assertFalse(DeletePolicy.owns(target, owner.copy(account = "meta:bob")))
        assertFalse(DeletePolicy.owns(target.copy(owner = null), owner))
    }

    @Test fun staleDeleteCompletionCannotClearALateCreateResponse() {
        var entry = DeletePolicy.created(admitted(), clientId, owner, "first")
        entry = DeletePolicy.request(entry)
        val deleting = entry.targets.single()
        val late = DeletePolicy.created(entry, clientId, owner, "second")
        val afterStaleCompletion = DeletePolicy.confirm(late, deleting)
        assertTrue(afterStaleCompletion.pending)
        assertEquals(setOf("first", "second"), afterStaleCompletion.targets.single().ids)
    }

    @Test fun concurrentAdmissionsCannotBeSettledByOnlyOneResponse() {
        val two = DeletePolicy.beforeCreate(admitted(), clientId, owner)!!
        val deleted = DeletePolicy.request(two)
        val one = DeletePolicy.created(deleted, clientId, owner, "remote-id")
        assertEquals(1, one.targets.single().outstandingCreates)
        assertTrue(DeletePolicy.confirm(one, one.targets.single()).pending)
        val both = DeletePolicy.created(one, clientId, owner, "remote-id")
        assertFalse(DeletePolicy.confirm(both, both.targets.single()).pending)
        assertFalse(DeletePolicy.mayUpload(both))
    }

    @Test fun serverAndAccountChangesRetainAllOriginalTargets() {
        val other = owner.copy(account = "meta:bob")
        val first = DeletePolicy.created(admitted(), clientId, owner, "alice-id")
        val second = DeletePolicy.beforeCreate(first, clientId, other)!!
        val deleted = DeletePolicy.request(second)
        val late = DeletePolicy.created(deleted, clientId, other, "bob-id")
        assertEquals(2, late.targets.size)
        assertEquals(setOf("alice-id", "bob-id"), late.targets.flatMap { it.ids }.toSet())
        assertTrue(late.pending)
        assertFalse(DeletePolicy.mayUpload(late))
    }
}
