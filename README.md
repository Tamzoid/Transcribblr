# Transcribblr

A web-based subtitle editor for audio/video transcription workflows. Built with pure Python and vanilla JavaScript.

## Features

- 🎵 Audio playback with vocal/full mix support
- ✏️ Real-time subtitle editing
- 🎯 Romaji conversion for Japanese text
- 🌐 Web-based interface (no installation required)
- 📱 Responsive design
- 🔄 Auto-save functionality
- 📋 SRT file format support

## Quick Start

### Prerequisites

- Python 3.7+
- FFmpeg (optional, for audio conversion)

### Simple Launch (Recommended)

```bash
python local.py
```

That's it! This will:
- Install dependencies automatically
- Build the web interface
- Create a `data/` folder in your project directory
- Start the server at http://localhost:8765
- Automatically open your browser
- Let you stop the server cleanly with Ctrl+P

> Local config is stored in `.env` and is ignored by git, so your machine-specific paths are not exposed.

### Advanced Usage

```bash
# Initialize config interactively
python local.py init

# Just setup without launching
python local.py setup

# Change port (then run python local.py to launch)
python local.py port 8080

# Change data directory (then run python local.py to launch)
python local.py data ./mydata
```

### Bootstrapper (For Custom Configurations)

If you need more control, use the bootstrapper directly:

```bash
# Custom data directory and port
python bootstrapper.py --data-path /path/to/data --port 8080

# Setup only
python bootstrapper.py --setup-only
```

# Just setup without launching
python bootstrapper.py --setup-only
```

## Data Directory Structure

When you run the bootstrapper, it creates this structure in your data directory:

```
data/
├── subtitles/     # Place your .srt files here
├── audio/         # Place your audio files here
└── config.json    # Auto-generated configuration
```

## Audio File Naming

For audio playback, name your files following this convention:

- **Vocals only:** `filename.vocals.m4a`
- **Full mix:** `filename.full.m4a`

Example:
```
subtitles/
  episode01.srt
  episode02.srt

audio/
  episode01.vocals.m4a
  episode01.full.m4a
  episode02.vocals.m4a
```

## Manual Setup (Alternative)

If you prefer manual setup:

1. **Install dependencies:**
   ```bash
   pip install -r src/requirements.txt
   ```

2. **Build web assets:**
   ```bash
   python build.py
   ```

3. **Create configuration:**
   Create a `config.json` file:
   ```json
   {
     "srt_dir": "/path/to/subtitles",
     "streamable_dir": "/path/to/audio",
     "port": 8765,
     "log_dir": "/path/to/logs"
   }
   ```

4. **Start the server:**
   ```bash
   python src/api/server.py
   ```

## API Endpoints

- `GET /` - Main web interface
- `GET /config` - Current configuration
- `GET /files` - List available SRT files
- `GET /data` - Get subtitle data for selected file
- `POST /selectfile` - Select active SRT file
- `POST /save` - Save subtitle changes
- `POST /romaji` - Convert text to romaji

## Development

### Project Structure

```
src/
├── api/           # Python backend
│   ├── server.py  # HTTP server
│   ├── config.py  # Configuration management
│   ├── audio.py   # Audio file handling
│   ├── srt.py     # SRT file parsing
│   └── ...
└── web/           # Frontend assets
    ├── index.html # Main page (built)
    ├── style.css  # Styles
    ├── *.js       # JavaScript modules
    └── templates/ # HTML partials
```

### Building

To rebuild the web assets after making changes:

```bash
python build.py
```

This inlines all CSS and JS into the HTML file for better performance.

## License

[Add your license here]

## Contributing

[Add contribution guidelines here]