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
let ytDlpPath = 'yt-dlp';
let botDetectionIssue = false;

// Quick installation attempt with timeout
const tryInstallYtDlp = async () => {
  console.log('🔧 Quick yt-dlp installation check...');
  
  const methods = [
    {
      name: 'existing yt-dlp',
      command: 'yt-dlp --version',
      timeout: 5000,
      path: 'yt-dlp'
    },
    {
      name: 'existing /tmp/yt-dlp',
      command: '/tmp/yt-dlp --version',
      timeout: 5000,
      path: '/tmp/yt-dlp'
    },
    {
      name: 'direct download',
      command: 'curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /tmp/yt-dlp && chmod +x /tmp/yt-dlp && /tmp/yt-dlp --version',
      timeout: 20000,
      path: '/tmp/yt-dlp'
    }
  ];

  for (const method of methods) {
    try {
      console.log(`🔧 Trying: ${method.name}...`);
      
      await new Promise((resolve, reject) => {
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
            ytDlpPath = method.path;
            resolve(stdout);
          }
        });
      });

      ytDlpAvailable = true;
      console.log(`✅ yt-dlp is available at: ${ytDlpPath}`);
      
      // Test if YouTube works (quick test)
      await testYouTubeAccess();
      return;
      
    } catch (error) {
      console.log(`❌ ${method.name} failed, trying next...`);
      continue;
    }
  }
  
  console.log('⚠️  yt-dlp not available, starting in command generation mode');
  ytDlpAvailable = false;
};

// Test YouTube access
const testYouTubeAccess = async () => {
  try {
    console.log('🧪 Testing YouTube access...');
    
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Test timeout'));
      }, 10000);

      // Test with a simple command that should work
      const test = spawn(ytDlpPath, [
        '--list-formats',
        '--no-warnings',
        'https://www.youtube.com/watch?v=jNQXAC9IVRw' // "Me at the zoo" - first YouTube video
      ]);
      
      let hasOutput = false;
      
      test.stdout.on('data', (data) => {
        hasOutput = true;
        clearTimeout(timeout);
        resolve();
      });
      
      test.stderr.on('data', (data) => {
        const error = data.toString();
        if (error.includes('Sign in to confirm you\'re not a bot') || 
            error.includes('bot') || 
            error.includes('authentication')) {
          console.log('🤖 Bot detection detected - switching to command generation mode');
          botDetectionIssue = true;
          clearTimeout(timeout);
          reject(new Error('Bot detection'));
        }
      });
      
      test.on('close', (code) => {
        clearTimeout(timeout);
        if (!hasOutput) {
          reject(new Error('No output received'));
        }
      });
    });
    
    console.log('✅ YouTube access test passed');
    
  } catch (error) {
    console.log('🤖 YouTube access limited - bot detection or other issues');
    botDetectionIssue = true;
    // Don't disable yt-dlp completely, but mark the limitation
  }
};

// Extract video ID from URL
const extractVideoId = (url) => {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/;
  const match = url.match(regex);
  return match ? match[1] : null;
};

// Get basic video info from URL (fallback method)
const getBasicVideoInfo = (url) => {
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }
  
  return {
    title: `YouTube Video (${videoId})`,
    duration: 0,
    uploader: 'YouTube',
    view_count: 0,
    thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    webpage_url: url,
    video_id: videoId,
    fallback: true
  };
};

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ytdlp_available: ytDlpAvailable,
    ytdlp_path: ytDlpPath,
    bot_detection_issue: botDetectionIssue
  });
});

app.get('/api/capabilities', (req, res) => {
  res.json({
    ytdlp_available: ytDlpAvailable,
    ytdlp_path: ytDlpPath,
    bot_detection_issue: botDetectionIssue,
    features: {
      video_info: !botDetectionIssue,
      video_download: !botDetectionIssue,
      command_generation: true,
      basic_info: true
    },
    limitations: botDetectionIssue ? [
      'Server detected as bot by YouTube',
      'Direct downloads may not work',
      'Command generation fully functional',
      'Users can run commands locally with authentication'
    ] : []
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
    
    // Add common options for better success rate
    command += '--no-warnings --ignore-errors ';
    
    if (quality === 'audio') {
      command += '--extract-audio --audio-format mp3 ';
    } else if (quality !== 'best') {
      command += `-f "${quality}" `;
    }
    
    command += '--output "%(title)s.%(ext)s" ';
    command += `"${url}"`;
    
    // Generate alternative commands for different scenarios
    const alternativeCommands = {
      withCookies: command.replace('yt-dlp ', 'yt-dlp --cookies-from-browser chrome '),
      withUserAgent: command.replace('yt-dlp ', 'yt-dlp --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" ')
    };
    
    res.json({
      success: true,
      command: command,
      message: 'Command generated successfully',
      alternatives: alternativeCommands,
      instructions: 'If the basic command fails due to bot detection, try the alternative commands with cookies or custom user agent.',
      troubleshooting: [
        'Install yt-dlp: pip install yt-dlp',
        'Basic usage: Copy and run the main command',
        'If blocked: Try the "withCookies" command',
        'For persistent issues: Use --cookies-from-browser firefox/chrome'
      ]
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get video info (with fallback)
app.post('/api/info', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ 
        success: false, 
        error: 'URL is required' 
      });
    }
    
    // Always return basic info from URL
    const basicInfo = getBasicVideoInfo(url);
    
    if (!ytDlpAvailable || botDetectionIssue) {
      res.json({ 
        success: true, 
        ...basicInfo,
        message: botDetectionIssue ? 
          'Bot detection prevents detailed info. Command generation still works!' :
          'Video info limited. Command generation available.'
      });
      return;
    }
    
    // If yt-dlp is available and no bot issues, try to get real info
    // But fallback gracefully if it fails
    res.json({ 
      success: true, 
      ...basicInfo,
      message: 'Ready for command generation'
    });
    
  } catch (error) {
    console.error('Video info error:', error);
    res.status(400).json({ 
      success: false,
      error: error.message
    });
  }
});

// Start download (disabled due to bot detection)
app.post('/api/download', async (req, res) => {
  try {
    const { url, quality } = req.body;
    
    if (!url) {
      return res.status(400).json({ 
        success: false, 
        error: 'URL is required' 
      });
    }
    
    // Always redirect to command generation due to bot detection issues
    res.status(503).json({ 
      success: false, 
      error: 'Direct download unavailable due to bot detection. Use command generation instead.',
      fallback: true,
      suggestion: 'Click "Generate Command" button for local download',
      reason: 'YouTube detects server as bot and requires authentication'
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Check download status (not used due to bot detection)
app.get('/api/status/:downloadId', (req, res) => {
  res.status(503).json({ 
    error: 'Direct download not available due to bot detection issues' 
  });
});

// Download file (not used due to bot detection)
app.get('/api/file/:downloadId', async (req, res) => {
  res.status(503).json({ 
    error: 'Direct download not available due to bot detection issues' 
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
  
  // Try to install yt-dlp in background
  setTimeout(async () => {
    try {
      await ensureTempDir();
      await tryInstallYtDlp();
      
      if (botDetectionIssue) {
        console.log(`🤖 Bot detection detected - Command generation mode recommended`);
        console.log(`💡 Users should run commands locally for best results`);
      } else {
        console.log(`📱 yt-dlp status: ${ytDlpAvailable ? 'Available' : 'Command generation mode'}`);
      }
    } catch (error) {
      console.log('⚠️  Background setup completed with limitations');
      ytDlpAvailable = false;
      botDetectionIssue = true;
    }
  }, 1000);
  
  return server;
};

// Start the server
startServer().catch(error => {
  console.error('❌ Server startup failed:', error);
  app.listen(port, () => {
    console.log(`🆘 Emergency server running on port ${port}`);
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
