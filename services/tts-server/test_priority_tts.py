import threading
import unittest
from priority_tts import PrioritySynthesis, SynthesisCancelled, SynthesisQueueFull


class PriorityTests(unittest.TestCase):
    def test_priority_fifo_and_single_worker(self):
        service = PrioritySynthesis()
        started = threading.Event()
        release = threading.Event()
        seen = []
        first, _ = service.submit(2, lambda cancel: (started.set(), release.wait(2), seen.append("first")))
        self.assertTrue(started.wait(1))
        low, _ = service.submit(2, lambda cancel: seen.append("low"))
        a, _ = service.submit(0, lambda cancel: seen.append("chat-a"))
        b, _ = service.submit(0, lambda cancel: seen.append("chat-b"))
        release.set()
        for future in [first, low, a, b]:
            future.result(2)
        self.assertEqual(seen, ["first", "chat-a", "chat-b", "low"])
        self.assertTrue(service.close())

    def test_active_cancel_stops_actual_work_before_next_request(self):
        service = PrioritySynthesis()
        started = threading.Event()
        stopped = threading.Event()
        def generate(cancel):
            started.set()
            cancel.wait(2)
            stopped.set()
            raise SynthesisCancelled()
        low, cancel = service.submit(2, generate)
        self.assertTrue(started.wait(1))
        chat, _ = service.submit(0, lambda event: stopped.is_set())
        cancel.set()
        with self.assertRaises(SynthesisCancelled):
            low.result(1)
        self.assertTrue(chat.result(1))
        self.assertTrue(service.close())

    def test_queued_cancel_never_runs_and_capacity_is_bounded(self):
        service = PrioritySynthesis(capacity=2)
        started = threading.Event()
        release = threading.Event()
        first, _ = service.submit(2, lambda cancel: (started.set(), release.wait(2)))
        self.assertTrue(started.wait(1))
        called = []
        second, cancel = service.submit(2, lambda event: called.append(True))
        with self.assertRaises(SynthesisQueueFull):
            service.submit(0, lambda event: None)
        cancel.set()
        release.set()
        first.result(1)
        with self.assertRaises(SynthesisCancelled):
            second.result(1)
        self.assertEqual(called, [])
        self.assertTrue(service.close())

    def test_failure_and_shutdown_release_capacity(self):
        service = PrioritySynthesis()
        def fail(cancel):
            raise ValueError("fixture")
        job, _ = service.submit(0, fail)
        with self.assertRaises(ValueError):
            job.result(1)
        following, _ = service.submit(0, lambda cancel: "ok")
        self.assertEqual(following.result(1), "ok")
        self.assertTrue(service.close())
        with self.assertRaises(SynthesisQueueFull):
            service.submit(0, lambda cancel: None)

    def test_explicit_cancel_and_cancel_before_post_are_idempotent(self):
        service = PrioritySynthesis()
        service.cancel_request('late')
        called = []
        late, _ = service.submit(2, lambda cancel: called.append(True), 'late')
        with self.assertRaises(SynthesisCancelled):
            late.result(1)
        self.assertEqual(called, [])
        started = threading.Event()
        def generate(cancel):
            started.set()
            cancel.wait(2)
            raise SynthesisCancelled()
        active, _ = service.submit(2, generate, 'active')
        self.assertTrue(started.wait(1))
        service.cancel_request('active')
        service.cancel_request('active')
        with self.assertRaises(SynthesisCancelled):
            active.result(1)
        self.assertTrue(service.close())


if __name__ == "__main__":
    unittest.main()
