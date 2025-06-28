const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Basic middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Global state
let serverReady = false;

// Critical health check for Render
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK',
    timestamp: new Date().toISOString(),
    server_ready: true
  });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    message: 'Server running - yt-dlp installation in progress'
  });
});

// Basic info endpoint
app.post('/api/info', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ 
        success: false, 
        error: 'URL is required' 
      });
    }
    
    // Extract video ID for basic info
    const videoId = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/)?.[1];
    
    const basicInfo = {
      title: `YouTube Video (${videoId || 'Unknown'})`,
      duration: 0,
      uploader: 'YouTube',
      view_count: 0,
      thumbnail: videoId ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg` : '',
      webpage_url: url,
      fallback: true
    };
    
    res.json({ 
      success: true, 
      ...basicInfo,
      message: 'Server starting up - using basic info'
    });
    
  } catch (error) {
    res.status(400).json({ 
      success: false,
      error: error.message
    });
  }
});

// Command generation (most important feature)
app.post('/api/command', (req, res) => {
  try {
    const { url, quality } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    let baseCommand = 'yt-dlp ';
    
    if (quality === 'audio') {
      baseCommand += '--extract-audio --audio-format mp3 ';
    } else if (quality !== 'best') {
      baseCommand += `-f "${quality}" `;
    }
    
    baseCommand += '--output "%(title)s.%(ext)s" ';
    baseCommand += `"${url}"`;
    
    const commands = {
      recommended: baseCommand.replace('yt-dlp ', 'yt-dlp --cookies-from-browser chrome '),
      basic: baseCommand,
      withChrome: baseCommand.replace('yt-dlp ', 'yt-dlp --cookies-from-browser chrome '),
      withFirefox: baseCommand.replace('yt-dlp ', 'yt-dlp --cookies-from-browser firefox '),
      enhanced: baseCommand.replace('yt-dlp ', 'yt-dlp --cookies-from-browser chrome --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --sleep-interval 3 ')
    };
    
    res.json({
      success: true,
      recommended: commands.recommended,
      commands: commands,
      message: 'Commands generated successfully',
      instructions: [
        'Server downloads may be limited due to YouTube restrictions.',
        'Use these manual commands with yt-dlp installed locally:',
        '1. Install yt-dlp on your computer',
        '2. Make sure you\'re logged into YouTube in your browser',
        '3. Copy and run the recommended command in terminal/command prompt'
      ],
      installation: {
        windows: 'Download yt-dlp.exe from GitHub releases',
        mac: 'brew install yt-dlp',
        linux: 'sudo apt install yt-dlp'
      }
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Download endpoint (returns manual instructions)
app.post('/api/download', (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ 
      success: false, 
      error: 'URL is required' 
    });
  }
  
  res.status(503).json({ 
    success: false, 
    error: 'Server downloads temporarily unavailable due to YouTube restrictions',
    manual_command: `yt-dlp --cookies-from-browser chrome "${url}"`,
    message: 'Use the manual command above to download locally',
    fallback: true
  });
});

// Capabilities
app.get('/api/capabilities', (req, res) => {
  res.json({
    server_ready: true,
    features: {
      command_generation: true,
      manual_commands: true,
      video_info: true,
      server_downloads: false // Disabled due to YouTube restrictions
    },
    message: 'Manual download commands available'
  });
});

// Serve main app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server immediately
const server = app.listen(port, () => {
  console.log(`🚀 Minimal server LIVE on port ${port}`);
  console.log(`✅ Health check ready at /health`);
  console.log(`📋 Command generation ready`);
  serverReady = true;
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('👋 Shutting down gracefully...');
  server.close(() => {
    process.exit(0);
  });
});
