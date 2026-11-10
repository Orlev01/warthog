"""A lost coordination lease must stop a real running child, not just a flag."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('private_runner', Path(__file__).parents[1]/'delivery/runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class RunnerProcessTests(unittest.TestCase):
    def test_lost_lease_terminates_the_mutating_process_group(self):
        checks = 0
        children = []
        original = subprocess.Popen
        def start(*args, **kwargs):
            child = original(*args, **kwargs)
            children.append(child)
            return child
        def lease():
            nonlocal checks
            checks += 1
            if checks > 1:
                raise RuntimeError('synthetic lease loss')
        with patch.object(runner,'LEASE_CHECK',lease), patch.object(runner.subprocess,'Popen',start):
            with self.assertRaisesRegex(RuntimeError, 'synthetic lease loss'):
                runner.run([sys.executable,'-c','import time; time.sleep(120)'])
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].poll())
        self.assertNotEqual(children[0].returncode, 0)

if __name__ == '__main__':
    unittest.main()
