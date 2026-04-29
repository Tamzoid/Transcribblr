#!/usr/bin/env python3
"""
Transcribblr Local Launcher
Simple launcher that handles everything automatically.
"""

import os
import subprocess
import sys
import time
from pathlib import Path


class LocalLauncher:
    """Simple launcher for Transcribblr."""

    def __init__(self):
        self.root_dir = Path(__file__).parent
        self.env_file = self.root_dir / ".env"
        self.data_dir = self.root_dir / "data"

        # Sensible defaults
        self.default_config = {
            "data_path": str(self.data_dir),
            "port": 8765,
            "log_path": "",
            "auto_open_browser": True
        }

        self.config = self._load_config()

    def _parse_env_file(self, path):
        config = {}
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' not in line:
                    continue
                key, value = line.split('=', 1)
                config[key.strip()] = value.strip().strip('"').strip("'")
        return config

    def _load_config(self):
        """Load configuration or use defaults."""
        if self.env_file.exists():
            try:
                raw = self._parse_env_file(self.env_file)
                return {
                    "data_path": raw.get("DATA_PATH", str(self.data_dir)),
                    "port": int(raw.get("PORT") or 8765),
                    "log_path": raw.get("LOG_PATH", ""),
                    "auto_open_browser": raw.get("AUTO_OPEN_BROWSER", "True").lower() in ("1", "true", "yes"),
                }
            except Exception:
                pass
        return self.default_config.copy()

    def _save_config(self):
        """Save current configuration."""
        env = {}
        if self.env_file.exists():
            env = self._parse_env_file(self.env_file)

        env.update({
            "DATA_PATH": self.config["data_path"],
            "PORT": str(self.config["port"]),
            "LOG_PATH": self.config["log_path"],
            "AUTO_OPEN_BROWSER": str(self.config["auto_open_browser"]).lower()
        })

        lines = [f"{key}={value}" for key, value in env.items()]
        with open(self.env_file, 'w', encoding='utf-8') as f:
            f.write("\n".join(lines) + "\n")

    def init_config(self):
        """Interactively initialize local configuration."""
        print("Initializing Transcribblr configuration")
        print("Press Enter to accept the default in brackets.")
        print()

        default_data = self.config["data_path"]
        data_path = input(f"Data directory [{default_data}]: ").strip() or default_data

        default_port = self.config["port"]
        while True:
            port_value = input(f"Port [{default_port}]: ").strip() or str(default_port)
            try:
                port = int(port_value)
                if port < 1 or port > 65535:
                    raise ValueError
                break
            except ValueError:
                print("Please enter a valid port number between 1 and 65535.")

        default_log = self.config["log_path"]
        log_path = input(f"Log directory [{default_log or '(none)'}]: ").strip()
        if not log_path:
            log_path = default_log

        default_browser = self.config["auto_open_browser"]
        browser_value = input(f"Open browser automatically [{default_browser}]: ").strip().lower()
        if browser_value in ("", "y", "yes", "true", "1"):
            auto_open_browser = True
        elif browser_value in ("n", "no", "false", "0"):
            auto_open_browser = False
        else:
            auto_open_browser = default_browser

        self.config.update({
            "data_path": data_path,
            "port": port,
            "log_path": log_path,
            "auto_open_browser": auto_open_browser,
        })
        self._save_config()

        print()
        print(f"Configuration saved to {self.env_file}")
        print(f"Data directory: {self.config['data_path']}")
        print(f"Port: {self.config['port']}")
        print(f"Auto open browser: {self.config['auto_open_browser']}")
        if self.config['log_path']:
            print(f"Log directory: {self.config['log_path']}")
        print("Run 'python local.py' to launch the app.")

    def launch(self):
        """Launch Transcribblr with current configuration."""
        # Ensure data directory exists
        Path(self.config["data_path"]).mkdir(parents=True, exist_ok=True)

        cmd = [sys.executable, "bootstrapper.py"]
        cmd.extend(["--data-path", self.config["data_path"]])
        cmd.extend(["--port", str(self.config["port"])])

        if self.config["log_path"]:
            cmd.extend(["--log-path", self.config["log_path"]])

        print("🚀 Starting Transcribblr...")
        print(f"📁 Data directory: {Path(self.config['data_path']).absolute()}")
        print(f"🌐 URL: http://localhost:{self.config['port']}")
        print()
        print("📋 To use Transcribblr:")
        print("1. Place your .srt files in the 'data/subtitles' folder")
        print("2. Place your audio files in the 'data/audio' folder")
        print("3. Your browser should open automatically")
        print()

        proc = None
        try:
            proc = subprocess.Popen(cmd, cwd=self.root_dir)

            if self.config["auto_open_browser"]:
                time.sleep(3)
                self._open_browser()

            print("Press Ctrl+C to stop the server.")
            while proc.poll() is None:
                time.sleep(0.5)

        except KeyboardInterrupt:
            print("\nStopping Transcribblr...")
            if proc is not None:
                self._terminate_process(proc)
        except Exception as e:
            print(f"❌ Error: {e}")

    def _open_browser(self):
        """Open browser to Transcribblr."""
        import webbrowser
        import time

        url = f"http://localhost:{self.config['port']}"
        print(f"🌐 Opening browser to {url}...")

        # Wait for server to start
        time.sleep(3)

        try:
            webbrowser.open(url)
        except Exception as e:
            print(f"⚠️  Could not open browser: {e}")
            print(f"   Please open {url} manually.")

    def setup(self):
        """Run setup only."""
        cmd = [sys.executable, "bootstrapper.py", "--setup-only"]
        cmd.extend(["--data-path", self.config["data_path"]])

        print("🔧 Setting up Transcribblr...")
        result = subprocess.run(cmd, cwd=self.root_dir)

        if result.returncode == 0:
            print("✅ Setup complete!")
        else:
            print("❌ Setup failed!")

    def _terminate_process(self, proc):
        """Terminate the child process and its entire tree."""
        if proc.poll() is not None:
            return

        print("Stopping the server...")
        if os.name == 'nt':
            subprocess.run(
                ['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                capture_output=True
            )
        else:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    def set_port(self, port):
        """Set the port."""
        self.config["port"] = port
        self._save_config()
        print(f"Port set to {port}. Run 'python local.py' to launch.")

    def set_data_path(self, path):
        """Set the data path."""
        self.config["data_path"] = path
        self._save_config()
        print(f"Data path set to {path}. Run 'python local.py' to launch.")


def main():
    """Simple command interface."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Transcribblr Local Launcher",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Usage:
  python local.py              # Launch Transcribblr (default)
  python local.py init         # Initialize local config interactively
  python local.py setup        # Setup only
  python local.py port 8080    # Change port
  python local.py data ./mydata # Change data directory
        """
    )

    parser.add_argument('command', nargs='?', default='launch',
                       choices=['launch', 'setup', 'init', 'port', 'data'],
                       help='Command to run (default: launch)')
    parser.add_argument('value', nargs='?', help='Value for command')

    args = parser.parse_args()

    launcher = LocalLauncher()

    if args.command == 'launch':
        launcher.launch()
    elif args.command == 'init':
        launcher.init_config()
        launcher.setup()
    elif args.command == 'port':
        if args.value:
            try:
                port = int(args.value)
                launcher.set_port(port)
                print(f"Port set to {port}. Run 'python local.py' to launch.")
            except ValueError:
                print("❌ Port must be a number")
        else:
            print(f"Current port: {launcher.config['port']}")
    elif args.command == 'data':
        if args.value:
            launcher.set_data_path(args.value)
            print(f"Data path set to {args.value}. Run 'python local.py' to launch.")
        else:
            print(f"Current data path: {launcher.config['data_path']}")


if __name__ == "__main__":
    main()