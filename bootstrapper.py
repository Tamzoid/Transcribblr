"""
Transcribblr Bootstrapper
Provides a simple way to launch the Transcribblr application with custom settings.
"""

import os
import sys
import json
import argparse
from pathlib import Path


class TranscribblrBootstrapper:
    """
    Bootstrapper for Transcribblr application.
    Handles configuration, dependency installation, building, and launching.
    """

    def __init__(self, data_path: str = None, port: int = 8765, log_path: str = None):
        """
        Initialize the bootstrapper.

        Args:
            data_path: Path to the directory containing SRT files and audio data.
                      If None, uses current directory.
            port: Port to run the server on (default: 8765)
            log_path: Path to store log files. If None, no logging to file.
        """
        self.data_path = Path(data_path) if data_path else Path.cwd()
        self.port = port
        self.log_path = log_path if log_path else None

        # Ensure data path exists
        self.data_path.mkdir(parents=True, exist_ok=True)

        self.env_path = Path(__file__).parent / ".env"

    def _parse_env_file(self, path: Path) -> dict:
        env = {}
        if not path.exists():
            return env
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                env[key.strip()] = value.strip().strip('"').strip("'")
        return env

    def _save_env(self, values: dict):
        env = self._parse_env_file(self.env_path)
        env.update(values)
        with open(self.env_path, 'w', encoding='utf-8') as f:
            for key, value in env.items():
                f.write(f"{key}={value}\n")

    def setup(self):
        """Set up the application: install dependencies and build web assets."""
        print("Setting up Transcribblr...")

        # Install dependencies
        self._install_dependencies()

        # Build web assets
        self._build_web_assets()

        print("Setup complete!")

    def launch(self):
        """Launch the Transcribblr server."""
        print(f"Starting Transcribblr server on port {self.port}...")

        config = {
            'DATA_PATH': os.path.relpath(self.data_path, start=Path(__file__).parent),
            'PORT': str(self.port),
            'LOG_DIR': os.path.relpath(self.log_path, start=Path(__file__).parent) if self.log_path else '',
            'SELECTED': ''
        }
        self._save_env(config)

        print(f"Data directory: {self.data_path}")
        print()
        print("To use Transcribblr:")
        print("1. Place your .srt subtitle files in the 'subtitles' directory")
        print("2. Place your audio files (.m4a) in the 'audio' directory")
        print(f"3. Open http://localhost:{self.port} in your browser")
        print()
        print("Audio file naming convention:")
        print("   - Vocals: filename.vocals.m4a")
        print("   - Full mix: filename.full.m4a")
        print()

        # Import and start server
        sys.path.insert(0, str(Path(__file__).parent / "src" / "api"))

        import server
        import config

        # Load config
        config.load_from_env(str(self.env_path))

        # Start server
        srv = server.start(self.port)

        try:
            import time
            print(f"Server running at http://localhost:{self.port}")
            print("Press Ctrl+C to stop...")
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\nShutting down server...")
            srv.shutdown()
            srv.server_close()

    def _install_dependencies(self):
        """Install Python dependencies."""
        print("Installing dependencies...")
        requirements_path = Path(__file__).parent / "src" / "requirements.txt"

        if not requirements_path.exists():
            print("WARNING: requirements.txt not found, skipping dependency installation")
            return

        import subprocess
        result = subprocess.run([
            sys.executable, '-m', 'pip', 'install', '-r', str(requirements_path)
        ], capture_output=True, text=True)

        if result.returncode != 0:
            print("ERROR: Failed to install dependencies:")
            print(result.stderr)
            raise RuntimeError("Dependency installation failed")

        print("Dependencies installed")

    def _build_web_assets(self):
        """Build the web assets by inlining CSS and JS."""
        print("Building web assets...")
        build_script = Path(__file__).parent / "build.py"

        if not build_script.exists():
            print("WARNING: build.py not found, skipping build")
            return

        import subprocess
        result = subprocess.run([
            sys.executable, str(build_script)
        ], capture_output=True, text=True, cwd=Path(__file__).parent)

        if result.returncode != 0:
            print("ERROR: Build failed:")
            print(result.stderr)
            raise RuntimeError("Build failed")

        print("Web assets built")


def main():
    """Command-line interface for the bootstrapper."""
    parser = argparse.ArgumentParser(description="Transcribblr Bootstrapper")
    parser.add_argument(
        "--data-path",
        type=str,
        help="Path to data directory (default: current directory)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="Port to run server on (default: 8765)"
    )
    parser.add_argument(
        "--log-path",
        type=str,
        help="Path to store log files"
    )
    parser.add_argument(
        "--setup-only",
        action="store_true",
        help="Only run setup, don't launch server"
    )

    args = parser.parse_args()

    bootstrapper = TranscribblrBootstrapper(
        data_path=args.data_path,
        port=args.port,
        log_path=args.log_path
    )

    bootstrapper.setup()

    if not args.setup_only:
        bootstrapper.launch()


if __name__ == "__main__":
    main()