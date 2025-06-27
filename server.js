const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs').promises;
const { spawn, exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
}));

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Create temp directory for downloads
const TEMP_DIR = '/tmp/downloads';
const ensureTempDir = async () => {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    console.log('📁 Temp directory ready');
  } catch (error) {
    console.log('📁 Temp directory already exists');
  }
};

// Download tracking
const downloadStatus = new Map();
let ytDlpAvailable = false;

// Quick installation attempt with timeout
const tryInstallYtDlp = async () => {
  console.log('🔧 Quick yt-dlp installation check...');
  
  const methods = [
    {
      name: 'existing yt-dlp',
      command: 'yt-dlp --version',
      timeout: 5000
    },
    {
      name: 'pip user install',
      command: 'pip install --user yt-dlp',
      timeout: 30000
    },
    {
      name: 'direct download',
      command: 'curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /tmp/yt-dlp && chmod +x /tmp/yt-dlp',
      timeout: 20000
    }
  ];

  for (const method of methods) {
    try {
      console.log(`🔧 Trying: ${method.name}...`);
      
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.log(`⏰ ${method.name} timed out`);
          reject(new Error('Timeout'));
        }, method.timeout);

        exec(method.command, (error, stdout, stderr) => {
          clearTimeout(timeout);
          if (error) {
            console.log(`❌ ${method.name} failed:`, error.message);
            reject(error);
          } else {
            console.log(`✅ ${method.name} succeeded`);
            resolve(stdout);
          }
        });
      });

      ytDlpAvailable = true;
      console.log('✅ yt-dlp is available!');
      return;
      
    } catch (error) {
      console.log(`❌ ${method.name} failed, trying next...`);
      continue;
    }
  }
  
  console.log('⚠️  yt-dlp not available, starting in command generation mode');
  ytDlpAvailable = false;
};

// Get yt-dlp command path
const getYtDlpPath = () => {
  const paths = ['yt-dlp', '/tmp/yt-dlp', '~/.local/bin/yt-dlp'];
  return paths[0]; // Default for now
};

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ytdlp_available: ytDlpAvailable
  });
});

app.get('/api/capabilities', (req, res) => {
  res.json({
    ytdlp_available: ytDlpAvailable,
    features: {
      video_info: ytDlpAvailable,
      video_download: ytDlpAvailable,
      command_generation: true
    }
  });
});

// Generate command (always works)
app.post('/api/command', (req, res) => {
  try {
    const { url, quality } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    let command = 'yt-dlp ';
    
    if (quality === 'audio') {
      command += '--extract-audio --audio-format mp3 ';
    } else if (quality !== 'best') {
      command += `-f "${quality}" `;
    }
    
    command += '--output "%(title)s.%(ext)s" ';
    command += `"${url}"`;
    
    res.json({
      success: true,
      command: command,
      message: 'Command generated successfully',
      instructions: 'Install yt-dlp locally and run this command in your terminal'
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get video info (only if yt-dlp available)
app.post('/api/info', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    if (!ytDlpAvailable) {
      return res.status(503).json({ 
        success: false, 
        error: 'Video info not available. Server running in command generation mode.',
        fallback: true
      });
    }
    
    // Try to get video info with timeout
    const info = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Video info request timed out'));
      }, 15000);

      const ytdlp = spawn(getYtDlpPath(), ['--dump-json', '--no-download', url]);
      let data = '';
      
      ytdlp.stdout.on('data', (chunk) => {
        data += chunk;
      });
      
      ytdlp.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          try {
            const parsed = JSON.parse(data);
            resolve({
              title: parsed.title,
              duration: parsed.duration,
              uploader: parsed.uploader,
              view_count: parsed.view_count
            });
          } catch (err) {
            reject(new Error('Failed to parse video info'));
          }
        } else {
          reject(new Error('Failed to get video info'));
        }
      });
    });
    
    res.json({ success: true, ...info });
    
  } catch (error) {
    res.status(400).json({ 
      success: false, 
      error: error.message,
      fallback: true
    });
  }
});

// Start download (only if yt-dlp available)
app.post('/api/download', async (req, res) => {
  if (!ytDlpAvailable) {
    return res.status(503).json({ 
      success: false, 
      error: 'Server-side downloading not available. Use command generation instead.',
      fallback: true
    });
  }
  
  // Implementation would go here, but for now just redirect to command generation
  res.status(503).json({ 
    success: false, 
    error: 'Direct download temporarily disabled. Use command generation.',
    fallback: true
  });
});

// Serve main app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize server with quick startup
const startServer = async () => {
  console.log('🚀 Starting YouTube Direct Downloader...');
  
  // Start server immediately
  const server = app.listen(port, () => {
    console.log(`🌟 Server running on port ${port}`);
    console.log(`🌍 Server is LIVE and ready for requests!`);
  });
  
  // Try to install yt-dlp in background (don't block server startup)
  setTimeout(async () => {
    try {
      await ensureTempDir();
      await tryInstallYtDlp();
      console.log(`📱 yt-dlp status: ${ytDlpAvailable ? 'Available' : 'Command generation mode'}`);
    } catch (error) {
      console.log('⚠️  Background setup completed with limitations');
      ytDlpAvailable = false;
    }
  }, 1000);
  
  return server;
};

// Start the server
startServer().catch(error => {
  console.error('❌ Server startup failed:', error);
  // Even if setup fails, start basic server
  app.listen(port, () => {
    console.log(`🆘 Emergency server running on port ${port}`);
    console.log(`📋 Command generation available`);
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});
