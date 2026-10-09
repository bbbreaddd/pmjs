"""Exercise minimal packaging with real ELF fixtures and MV/MZ inspection."""
import ctypes
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import release
import portmaster


class PortMasterPackage(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pmjs package with spaces ')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.stage = self.root / 'runtime'
        (self.stage / 'bin').mkdir(parents=True)
        (self.stage / 'lib').mkdir()
        shutil.copy2('/bin/true', self.stage / 'bin/node')
        for name, source, flags in [
            ('librequired.so.1', 'int required(void) { return 42; }', []),
            ('libunused.so.1', 'int unused(void) { return 0; }', []),
            ('pmjs_native.node', 'extern int required(void); int example(void) { return required(); }',
             ['-L' + str(self.stage / 'lib'), '-l:librequired.so.1', '-Wl,-rpath,$ORIGIN'])
        ]:
            subprocess.run(['cc', '-shared', '-fPIC', '-g', '-x', 'c', '-', '-o', self.stage / 'lib' / name,
                            *flags], input=source, text=True, check=True)
        share = self.stage / 'share/pmjs'
        share.mkdir(parents=True)
        for directory in ('js', 'runner', 'profiles'):
            shutil.copytree(ROOT / directory, share / directory)
        (share / 'tools').mkdir()
        for file in ('build-js-runtime.mjs', 'game-inspect.mjs'):
            shutil.copy2(ROOT / 'tools' / file, share / 'tools' / file)
        (share / 'notices').mkdir()
        (share / 'notices/Node.LICENSE').write_text('fixture notice')
        (share / 'sources').mkdir()
        (share / 'sources/unused-source.tar.xz').write_text('not needed at runtime')
        for file in ('LICENSE', 'THIRD_PARTY_NOTICES.md'):
            shutil.copy2(ROOT / file, self.stage / file)
        self.refresh_manifest()
        self.game = self.root / 'purchased game'
        (self.game / 'js/libs').mkdir(parents=True)
        (self.game / 'data').mkdir()
        (self.game / 'data/System.json').write_text('{"gameTitle":"Minimal Game"}')
        (self.game / 'index.html').write_text('purchased bytes must not be copied')
        (self.game / 'js/rpg_core.js').write_text('Utils.RPGMAKER_VERSION = "1.6.2";')
        (self.game / 'js/rpg_managers.js').write_text('')
        (self.game / 'js/libs/pixi.js').write_text('PIXI.VERSION = "4.5.4";')
        (self.game / 'js/libs/pixi-tilemap.js').write_text('')
        (self.game / 'js/plugins.js').write_text('var $plugins = [];')
        self.output = self.root / 'output/game.zip'

    def refresh_manifest(self):
        release.write_json(self.stage / 'build-info.json', {'schema': 1, 'architecture': 'x86_64',
                           'source': {'sourceDateEpoch': 0}, 'files': release.inventory(self.stage)})

    def test_minimal_contents_and_stripping(self):
        original = release.inventory(self.stage)
        portmaster.portmaster(self.stage, self.game, self.output)
        with zipfile.ZipFile(self.output) as package:
            self.assertIsNone(package.testzip())
            names = package.namelist()
            self.assertIn('Minimal Game.sh', names)
            self.assertIn('minimal-game/gamedata/', names)
            self.assertIn('minimal-game/runtime/lib/librequired.so.1', names)
            licenses = package.read('minimal-game/runtime/LICENSES.txt').decode()
            self.assertIn('Node.LICENSE', licenses)
            self.assertIn('fixture notice', licenses)
            self.assertFalse(any('libunused' in name or '/sources/' in name or '/tools/' in name or
                                 '/profiles/' in name or name.endswith(('port.json', 'config.json', 'build-info.json'))
                                 for name in names))
            self.assertEqual([name for name in names if '/gamedata/' in name], ['minimal-game/gamedata/'])
            self.assertEqual(package.getinfo('Minimal Game.sh').external_attr >> 16 & 0o777, 0o755)
            binary = self.root / 'pmjs_native.node'
            binary.write_bytes(package.read('minimal-game/runtime/lib/pmjs_native.node'))
            (self.root / 'librequired.so.1').write_bytes(package.read('minimal-game/runtime/lib/librequired.so.1'))
            sections = subprocess.check_output(['readelf', '-S', '--wide', binary], text=True)
            self.assertNotIn('.debug', sections)
            self.assertNotIn('.symtab', sections)
            self.assertEqual(ctypes.CDLL(str(binary)).example(), 42, 'stripped code and dependency load')
        self.assertEqual(release.inventory(self.stage), original)
        self.assertEqual(list(self.output.parent.iterdir()), [self.output], 'one ZIP, no companion files')
        checksum = release.digest(self.output)
        portmaster.portmaster(self.stage, self.game, self.output)
        self.assertEqual(release.digest(self.output), checksum, 'deterministic ZIP')

    def test_adapter_configuration_and_mz(self):
        adapter = self.root / 'adapter.js'
        adapter.write_text('globalThis.adapterRegistered = true;')
        config = self.root / 'config.json'
        config.write_text('{"display":{"width":960,"height":720}}')
        for engine in ('mv', 'mz'):
            if engine == 'mz':
                (self.game / 'js/rpg_core.js').unlink()
                (self.game / 'js/rmmz_core.js').write_text('Utils.RPGMAKER_VERSION = "1.10.0";')
                (self.game / 'js/libs/pixi.js').write_text('PIXI.VERSION = "5.3.12";')
            portmaster.portmaster(self.stage, self.game, self.output, config=config, adapters=[adapter])
            with zipfile.ZipFile(self.output) as package:
                bundle = package.read('minimal-game/bootstrap.js').decode()
                self.assertLess(bundle.index('adapterRegistered'), bundle.index(f'// BEGIN js/pmjs-{engine}/bootstrap.js'))
                self.assertEqual(package.read('minimal-game/config.json'), config.read_bytes())

    def test_failure_preserves_existing_zip(self):
        self.output.parent.mkdir()
        self.output.write_bytes(b'existing package')
        with self.assertRaises(subprocess.CalledProcessError):
            portmaster.portmaster(self.stage, self.game, self.output, strip='/bin/false')
        self.assertEqual(self.output.read_bytes(), b'existing package')

    def test_wrong_strip_tool_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'left debug information'):
            portmaster.portmaster(self.stage, self.game, self.output, strip='/bin/true')
        self.assertFalse(self.output.exists())

    def test_unbundled_node_and_changed_runtime_are_rejected(self):
        (self.stage / 'bin/node').unlink()
        self.refresh_manifest()
        with self.assertRaisesRegex(ValueError, 'bundled target Node'):
            portmaster.portmaster(self.stage, self.game, self.output)
        (self.stage / 'LICENSE').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'differ from build-info'):
            portmaster.portmaster(self.stage, self.game, self.output)

    def test_output_and_name_cannot_escape(self):
        with self.assertRaisesRegex(ValueError, 'outside'):
            portmaster.portmaster(self.stage, self.game, self.game / 'game.zip')
        with self.assertRaisesRegex(ValueError, 'path separators'):
            portmaster.portmaster(self.stage, self.game, self.output, name='../escape')


class PortMasterLauncher(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pmjs firmware with spaces ')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.control = self.root / 'PortMaster'
        self.control.mkdir()
        self.port = self.root / 'storage/ports/minimal-game'
        (self.port / 'gamedata').mkdir(parents=True)
        (self.port / 'gamedata/index.html').touch()
        (self.port / 'saves').mkdir()
        (self.port / 'saves/existing.rpgsave').write_text('existing progress')
        (self.port / 'runtime/bin').mkdir(parents=True)
        self.launcher = self.root / 'menu/Minimal Game.sh'
        self.launcher.parent.mkdir()
        self.launcher.write_text(portmaster.PORTMASTER_LAUNCHER.replace('@ID@', 'minimal-game'))
        self.events = self.root / 'events.txt'
        self.capture = self.root / 'node.json'
        node = self.port / 'runtime/bin/node'
        node.write_text('#!' + sys.executable + '\n' + '''import json, os, signal, sys
from pathlib import Path
Path(os.environ['CAPTURE']).write_text(json.dumps({
    'argv': sys.argv[1:], 'env': dict(os.environ), 'pid': os.getpid(), 'uid': os.getuid()
}))
if 'READY_FD' in os.environ:
    if os.environ.get('IGNORE_TERM') == '1':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    os.write(int(os.environ['READY_FD']), b'1')
    signal.pause()
sys.exit(int(os.environ.get('NODE_STATUS', '0')))
''')
        node.chmod(0o755)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(('SDL_', 'PMJS_', 'PORTMASTER_')) and
                    key not in ('controlfolder', 'directory', 'HOTKEY', 'LD_LIBRARY_PATH')}
        self.env.update(PORTMASTER_CONTROL_DIR=str(self.control), EVENTS=str(self.events),
                        CAPTURE=str(self.capture), CFW_NAME='fixture')
        (self.control / 'control.txt').write_text('export directory=' +
            shlex.quote(str(self.root / 'storage').lstrip('/')) + '\n' + r'''
[ -z "${DIRECTORY_OVERRIDE:-}" ] || directory="$DIRECTORY_OVERRIDE"
export LD_LIBRARY_PATH=/firmware/lib
get_controls() {
  sdl_controllerconfig=firmware-map
  export SDL_GAMECONTROLLERCONFIG_FILE="$controlfolder/gamecontrollerdb.txt"
  HOTKEY=${FIRMWARE_HOTKEY:-}
  return "${CONTROLS_STATUS:-0}"
}
pm_platform_helper() { echo unexpected-base-helper >> "$EVENTS"; }
pm_finish() {
  printf 'finish:%s\n' "$LD_LIBRARY_PATH" >> "$EVENTS"
  return "${FINISH_STATUS:-0}"
}
trap 'echo unexpected-source-trap >> "$EVENTS"' EXIT
return "${CONTROL_STATUS:-0}"
''')
        self.module = r'''
export MODULE_LOADED=1
pm_platform_helper() {
  printf 'platform:%s\n' "$1" >> "$EVENTS"
  return "${PLATFORM_STATUS:-0}"
}
trap 'echo unexpected-module-trap >> "$EVENTS"' EXIT
return "${MODULE_STATUS:-0}"
'''
        (self.control / 'mod_fixture.txt').write_text(self.module)

    def run_launcher(self, **values):
        self.events.unlink(missing_ok=True)
        self.capture.unlink(missing_ok=True)
        result = subprocess.run(['bash', self.launcher], env={**self.env, **values},
                                capture_output=True, text=True, timeout=5)
        events = self.events.read_text().splitlines() if self.events.exists() else []
        self.assertEqual(events.count('finish:/firmware/lib'), 1, events)
        self.assertFalse(any('unexpected' in event for event in events), events)
        self.assertEqual((self.port / 'saves/existing.rpgsave').read_text(), 'existing progress')
        return result

    def test_firmware_modules_paths_and_inherited_settings(self):
        inherited = {'WAYLAND_DISPLAY': 'wayland-custom', 'DISPLAY': ':7',
                     'XDG_RUNTIME_DIR': '/run/user/1002', 'SWAYSOCK': '/run/custom-sway.sock',
                     'SDL_VIDEODRIVER': 'firmware-backend', 'SDL_VIDEO_EGL_DRIVER': '/firmware/egl.so',
                     'SDL_VIDEO_GL_DRIVER': '/firmware/gles.so', 'SDL_AUDIODRIVER': 'pipewire',
                     'SDL_ROTATION': '90', 'SDL_BLITTER_DISABLED': '0',
                     'SDL_KMSDRM_REQUIRE_DRM_MASTER': '0', 'SDL_GAMECONTROLLERCONFIG': 'custom-map'}
        for firmware in ('muOS', 'ROCKNIX', 'knulli', 'dArkOS', 'AmberELEC', 'ArkOS'):
            with self.subTest(firmware=firmware):
                (self.control / f'mod_{firmware}.txt').write_text(self.module)
                result = self.run_launcher(CFW_NAME=firmware,
                                           DIRECTORY_OVERRIDE=str(self.root / 'storage'), **inherited)
                self.assertEqual(result.returncode, 0, result.stderr)
                capture = json.loads(self.capture.read_text())
                self.assertEqual(capture['uid'], os.getuid(), 'frontend identity is preserved')
                for name, value in inherited.items():
                    self.assertEqual(capture['env'][name], value)
                self.assertEqual(capture['env']['MODULE_LOADED'], '1')
                self.assertEqual(capture['env']['LD_LIBRARY_PATH'], str(self.port / 'runtime/lib') + ':/firmware/lib')
                self.assertEqual(capture['env']['SDL_GAMECONTROLLERCONFIG_FILE'], str(self.control / 'gamecontrollerdb.txt'))
                self.assertIn('platform:' + str(self.port / 'runtime/bin/node'), self.events.read_text())
                self.assertIn(str(self.port / 'gamedata'), capture['argv'])

    def test_xdg_discovery_adjacent_game_and_absent_display_settings(self):
        (self.control / 'control.txt').write_text((self.control / 'control.txt').read_text().replace(
            'export directory=', 'unused_directory='))
        self.launcher.rename(self.port.parent / 'Minimal Game.sh')
        self.launcher = self.port.parent / 'Minimal Game.sh'
        self.env.pop('PORTMASTER_CONTROL_DIR')
        self.env.update(XDG_DATA_HOME=str(self.root))
        for name in ('DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'SWAYSOCK'):
            self.env.pop(name, None)
        self.assertEqual(self.run_launcher().returncode, 0)
        env = json.loads(self.capture.read_text())['env']
        for name in ('DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'SWAYSOCK', 'PMJS_EXIT_HOTKEY'):
            self.assertNotIn(name, env)
        self.assertEqual(env['SDL_GAMECONTROLLERCONFIG'], 'firmware-map')

    def test_firmware_exit_chords_and_explicit_override(self):
        for hotkey, expected in (('l3', 'leftstick'), ('r3', 'rightstick'), ('select', 'back'),
                                 ('back', 'back'), ('guide', 'guide')):
            with self.subTest(hotkey=hotkey):
                self.assertEqual(self.run_launcher(FIRMWARE_HOTKEY=hotkey).returncode, 0)
                self.assertEqual(json.loads(self.capture.read_text())['env']['PMJS_EXIT_HOTKEY'], expected)
        self.assertEqual(self.run_launcher(FIRMWARE_HOTKEY='l3', PMJS_EXIT_HOTKEY='none').returncode, 0)
        self.assertEqual(json.loads(self.capture.read_text())['env']['PMJS_EXIT_HOTKEY'], 'none')

    def test_setup_and_runtime_failures_restore_firmware(self):
        for setting, status in (('CONTROL_STATUS', 7), ('MODULE_STATUS', 8),
                                ('CONTROLS_STATUS', 1), ('PLATFORM_STATUS', 1), ('NODE_STATUS', 23)):
            with self.subTest(setting=setting):
                result = self.run_launcher(**{setting: str(status)})
                self.assertEqual(result.returncode, status)
                self.assertEqual(self.capture.exists(), setting == 'NODE_STATUS')
        (self.port / 'gamedata/index.html').unlink()
        self.assertEqual(self.run_launcher().returncode, 1)
        self.assertFalse(self.capture.exists())

    def test_cleanup_failure_retains_game_failure(self):
        self.assertEqual(self.run_launcher(FINISH_STATUS='9').returncode, 1)
        self.assertIn('PortMaster cleanup failed', (self.port / 'log.txt').read_text())
        self.assertEqual(self.run_launcher(FINISH_STATUS='9', NODE_STATUS='23').returncode, 23)

    def test_unusable_log_directory_stops_before_startup(self):
        (self.port / 'log.txt').mkdir()
        self.assertEqual(self.run_launcher().returncode, 1)
        self.assertFalse(self.capture.exists())

    def test_termination_stops_owned_node_before_firmware_cleanup(self):
        for ignore_term in ('0', '1'):
            with self.subTest(ignore_term=ignore_term):
                self.check_termination(ignore_term)

    def check_termination(self, ignore_term):
        read_fd, write_fd = os.pipe()
        try:
            process = subprocess.Popen(['bash', self.launcher],
                                       env={**self.env, 'READY_FD': str(write_fd), 'IGNORE_TERM': ignore_term},
                                       pass_fds=(write_fd,), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            os.close(write_fd)
            write_fd = None
            self.addCleanup(lambda: process.kill() if process.poll() is None else None)
            self.assertTrue(select.select([read_fd], [], [], 5)[0], 'Node started')
            self.assertEqual(os.read(read_fd, 1), b'1')
            node_pid = json.loads(self.capture.read_text())['pid']
            process.terminate()
            process.communicate(timeout=8)
            self.assertEqual(process.returncode, 143)
            with self.assertRaises(ProcessLookupError):
                os.kill(node_pid, 0)
            self.assertEqual(self.events.read_text().splitlines()[-1], 'finish:/firmware/lib')
        finally:
            os.close(read_fd)
            if write_fd is not None:
                os.close(write_fd)


if __name__ == '__main__':
    unittest.main()
