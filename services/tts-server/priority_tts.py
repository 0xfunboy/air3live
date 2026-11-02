"""Bounded single-worker synthesis. Cancellation is checked by the generator.

No torch/FastAPI import: concurrency and cleanup are testable without a GPU.
"""
import concurrent.futures
import heapq
import itertools
import threading
import time


class SynthesisCancelled(Exception):
    pass


class SynthesisQueueFull(Exception):
    pass


class PrioritySynthesis:
    def __init__(self, capacity=8):
        self.capacity = capacity
        self.condition = threading.Condition()
        self.sequence = itertools.count()
        self.pending = []
        self.current = None
        self.closed = False
        self.completed = 0
        self.cancelled = 0
        self.failed = 0
        self.request_ids = {}
        self.worker = threading.Thread(target=self._run, name="air3-editorial-tts", daemon=True)
        self.worker.start()

    def submit(self, priority, generate, request_id=None):
        with self.condition:
            self._prune_ids()
            if self.closed or len(self.pending) + bool(self.current) >= self.capacity:
                raise SynthesisQueueFull()
            future = concurrent.futures.Future()
            cancel = threading.Event()
            if request_id is not None:
                if request_id in self.request_ids:
                    cancel.set()
                elif len(self.request_ids) >= 512:
                    raise SynthesisQueueFull()
                else:
                    self.request_ids[request_id] = (cancel, time.monotonic() + 90)
            heapq.heappush(self.pending, (priority, next(self.sequence), future, cancel, generate))
            self.condition.notify()
            return future, cancel

    def _prune_ids(self):
        now = time.monotonic()
        self.request_ids = {key: value for key, value in self.request_ids.items() if value[1] > now}

    def cancel_request(self, request_id):
        with self.condition:
            self._prune_ids()
            if request_id in self.request_ids:
                self.request_ids[request_id][0].set()
            else:
                if len(self.request_ids) >= 512:
                    raise SynthesisQueueFull()
                cancel = threading.Event()
                cancel.set()
                self.request_ids[request_id] = (cancel, time.monotonic() + 90)
            self.condition.notify_all()

    def _run(self):
        while True:
            with self.condition:
                while not self.pending and not self.closed:
                    self.condition.wait()
                if self.closed and not self.pending:
                    return
                _, _, future, cancel, generate = heapq.heappop(self.pending)
                self.current = cancel
            try:
                if cancel.is_set():
                    raise SynthesisCancelled()
                value = generate(cancel)
                if cancel.is_set():
                    raise SynthesisCancelled()
                if not future.done():
                    future.set_result(value)
                with self.condition:
                    self.completed += 1
            except BaseException as error:
                with self.condition:
                    if isinstance(error, SynthesisCancelled):
                        self.cancelled += 1
                    else:
                        self.failed += 1
                if not future.done():
                    future.set_exception(error)
            finally:
                with self.condition:
                    self.current = None
                    self.condition.notify_all()

    def close(self, timeout=5):
        with self.condition:
            self.closed = True
            if self.current:
                self.current.set()
            for _, _, future, cancel, _ in self.pending:
                cancel.set()
                if not future.done():
                    future.set_exception(SynthesisCancelled())
            self.pending.clear()
            self.condition.notify_all()
        self.worker.join(timeout)
        return not self.worker.is_alive()

    def snapshot(self):
        with self.condition:
            return {"active": bool(self.current), "pending": len(self.pending),
                    "completed": self.completed, "cancelled": self.cancelled, "failed": self.failed}
