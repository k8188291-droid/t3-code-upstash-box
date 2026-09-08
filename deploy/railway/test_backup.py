import importlib.util
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

backup = load('backup', 'backup.py')
manager = load('manager', 'manage-backups.py')

class BackupTests(unittest.TestCase):
    def test_sqlite_wal_and_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'home'
            root.mkdir()
            db = sqlite3.connect(root / 'state.sqlite')
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE state(value TEXT)')
            db.execute("INSERT INTO state VALUES ('committed-in-wal')")
            db.commit()
            (root / 'linked').symlink_to('state.sqlite')
            with patch.object(backup, 'HOME_DIR', root):
                stage = Path(tmp) / 'stage'
                shutil.copytree(root, stage, symlinks=True, ignore=backup.ignored, copy_function=backup.copy_file)
            with sqlite3.connect(stage / 'state.sqlite') as restored:
                self.assertEqual(restored.execute('SELECT value FROM state').fetchone(), ('committed-in-wal',))
            self.assertFalse((stage / 'state.sqlite-wal').exists())
            self.assertTrue((stage / 'linked').is_symlink())
            db.close()

    def test_restore_refuses_existing_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / 'keep').write_text('valuable')
            with self.assertRaises(RuntimeError):
                backup.restore('snapshot', tmp)
            self.assertEqual((Path(tmp) / 'keep').read_text(), 'valuable')

    def test_delete_gate_rejects_unverified_backup(self):
        with patch.object(manager, 'remote', return_value='{"snapshot_id":"abc","verified_restore":false}'):
            with self.assertRaises(RuntimeError):
                manager.confirmed_final({}, 'service')

    def test_delete_gate_propagates_backup_failure(self):
        with patch.object(manager, 'remote', side_effect=RuntimeError('upload failed')):
            with self.assertRaises(RuntimeError):
                manager.confirmed_final({}, 'service')

if __name__ == '__main__':
    unittest.main()
