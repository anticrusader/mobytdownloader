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
let directDownloadAttempts = 0;
let successfulDownloads = 0;

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
      
      // Quick test for bot detection
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

// Test YouTube access with anti-detection measures
const testYouTubeAccess = async () => {
  try {
    console.log('🧪 Testing YouTube access with anti-detection...');
    
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log('⏰ YouTube test timed out');
        botDetectionIssue = true;
        reject(new Error('Test timeout'));
      }, 15000);

      // Test with anti-detection measures
      const test = spawn(ytDlpPath, [
        '--list-formats',
        '--no-warnings',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--extractor-args', 'youtube:player_client=web',
        'https://www.youtube.com/watch?v=jNQXAC9IVRw' // First YouTube video
      ]);
      
      let hasOutput = false;
      let errorOutput = '';
      
      test.stdout.on('data', (data) => {
        hasOutput = true;
        clearTimeout(timeout);
        console.log('✅ YouTube access test passed');
        botDetectionIssue = false;
        resolve();
      });
      
      test.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });
      
      test.on('close', (code) => {
        clearTimeout(timeout);
        if (!hasOutput) {
          console.log('🤖 YouTube access limited:', errorOutput);
          if (errorOutput.includes('Sign in to confirm') || 
              errorOutput.includes('bot') || 
              errorOutput.includes('authentication')) {
            botDetectionIssue = true;
            console.log('🤖 Bot detection confirmed - hybrid mode enabled');
          }
          reject(new Error('No output or bot detection'));
        }
      });
    });
    
  } catch (error) {
    console.log('🤖 YouTube access test failed - enabling hybrid mode');
    botDetectionIssue = true;
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

// Enhanced video info with anti-detection
const getVideoInfo = (url) => {
  return new Promise(async (resolve, reject) => {
    if (!ytDlpAvailable) {
      reject(new Error('yt-dlp not available'));
      return;
    }

    console.log(`🔍 Getting video info with enhanced anti-detection: ${url}`);
    
    // Multiple strategies to try in order
    const strategies = [
      {
        name: 'web_client',
        args: [
          '--dump-json', '--no-download', '--no-warnings', '--ignore-errors',
          '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          '--add-header', 'Accept-Language:en-US,en;q=0.9',
          '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          '--extractor-args', 'youtube:player_client=web',
          url
        ]
      },
      {
        name: 'android_client',
        args: [
          '--dump-json', '--no-download', '--no-warnings', '--ignore-errors',
          '--user-agent', 'com.google.android.youtube/17.36.4 (Linux; U; Android 12; GB) gzip',
          '--extractor-args', 'youtube:player_client=android',
          url
        ]
      },
      {
        name: 'ios_client',
        args: [
          '--dump-json', '--no-download', '--no-warnings', '--ignore-errors',
          '--user-agent', 'com.google.ios.youtube/17.36.4 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)',
          '--extractor-args', 'youtube:player_client=ios',
          url
        ]
      },
      {
        name: 'tv_client',
        args: [
          '--dump-json', '--no-download', '--no-warnings', '--ignore-errors',
          '--extractor-args', 'youtube:player_client=tv_embedded',
          url
        ]
      }
    ];
    
    // Try each strategy
    for (const strategy of strategies) {
      try {
        console.log(`🔧 Trying ${strategy.name} strategy...`);
        
        const info = await new Promise((strategyResolve, strategyReject) => {
          const ytdlp = spawn(ytDlpPath, strategy.args);
          let data = '';
          let errorData = '';
          
          ytdlp.stdout.on('data', (chunk) => {
            data += chunk;
          });
          
          ytdlp.stderr.on('data', (chunk) => {
            errorData += chunk;
          });
          
          ytdlp.on('close', (code) => {
            if (code === 0 && data.trim()) {
              try {
                const parsed = JSON.parse(data.trim());
                strategyResolve(parsed);
              } catch (parseError) {
                strategyReject(new Error('Parse error: ' + parseError.message));
              }
            } else {
              strategyReject(new Error(`Strategy failed: ${errorData}`));
            }
          });

          // Timeout for each strategy
          setTimeout(() => {
            ytdlp.kill();
            strategyReject(new Error('Strategy timeout'));
          }, 20000);
        });
        
        // Success! Return the info
        console.log(`✅ ${strategy.name} strategy succeeded`);
        resolve({
          title: info.title || 'Unknown Title',
          duration: info.duration || 0,
          uploader: info.uploader || 'Unknown Uploader',
          view_count: info.view_count || 0,
          thumbnail: info.thumbnail || '',
          webpage_url: info.webpage_url || url,
          strategy_used: strategy.name
        });
        return;
        
      } catch (error) {
        console.log(`❌ ${strategy.name} failed:`, error.message);
        continue;
      }
    }
    
    // All strategies failed
    console.log('🤖 All anti-detection strategies failed - bot detection confirmed');
    botDetectionIssue = true;
    reject(new Error('All anti-detection strategies failed'));
  });
};


// Enhanced download with multiple strategies
const downloadVideo = (url, quality, downloadId) => {
  return new Promise(async (resolve, reject) => {
    if (!ytDlpAvailable) {
      reject(new Error('yt-dlp not available'));
      return;
    }

    directDownloadAttempts++;
    console.log(`⬇️ Starting enhanced download (attempt ${directDownloadAttempts}): ${downloadId}`);
    
    const filename = `${downloadId}.%(ext)s`;
    const outputPath = path.join(TEMP_DIR, filename);
    
    // Multiple download strategies
    const downloadStrategies = [
      {
        name: 'enhanced_web',
        args: [
          '-o', outputPath, '--newline', '--no-warnings', '--ignore-errors',
          '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          '--add-header', 'Accept-Language:en-US,en;q=0.9',
          '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          '--add-header', 'Sec-Fetch-Mode:navigate',
          '--add-header', 'Sec-Fetch-Site:none',
          '--sleep-interval', '1', '--max-sleep-interval', '3',
          '--retries', '3', '--fragment-retries', '3',
          '--extractor-args', 'youtube:player_client=web'
        ]
      },
      {
        name: 'android_fallback',
        args: [
          '-o', outputPath, '--newline', '--no-warnings', '--ignore-errors',
          '--user-agent', 'com.google.android.youtube/17.36.4 (Linux; U; Android 12; GB) gzip',
          '--sleep-interval', '2', '--max-sleep-interval', '5',
          '--retries', '5', '--fragment-retries', '5',
          '--extractor-args', 'youtube:player_client=android'
        ]
      },
      {
        name: 'ios_fallback',
        args: [
          '-o', outputPath, '--newline', '--no-warnings', '--ignore-errors',
          '--user-agent', 'com.google.ios.youtube/17.36.4 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)',
          '--sleep-interval', '3', '--max-sleep-interval', '7',
          '--retries', '7', '--fragment-retries', '7',
          '--extractor-args', 'youtube:player_client=ios'
        ]
      }
    ];
    
    // Add quality settings to all strategies
    for (const strategy of downloadStrategies) {
      if (quality === 'audio') {
        strategy.args.push('--extract-audio', '--audio-format', 'mp3');
      } else if (quality !== 'best') {
        strategy.args.push('-f', quality);
      }
      strategy.args.push(url);
    }
    
    // Try each download strategy
    for (const strategy of downloadStrategies) {
      try {
        console.log(`🔧 Trying ${strategy.name} download strategy...`);
        
        await new Promise((strategyResolve, strategyReject) => {
          const ytdlp = spawn(ytDlpPath, strategy.args);
          let hasProgress = false;
          
          downloadStatus.set(downloadId, {
            status: 'downloading',
            progress: 0,
            strategy: strategy.name
          });
          
          ytdlp.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`${strategy.name} output:`, output);
            
            // Parse progress
            const progressMatch = output.match(/(\d+(?:\.\d+)?)%/);
            if (progressMatch) {
              hasProgress = true;
              const progress = parseFloat(progressMatch[1]);
              downloadStatus.set(downloadId, {
                status: 'downloading',
                progress: progress,
                strategy: strategy.name
              });
            }
          });
          
          ytdlp.stderr.on('data', (data) => {
            const error = data.toString();
            console.error(`${strategy.name} stderr:`, error);
            
            // Check for bot detection
            if (error.includes('Sign in to confirm') || 
                error.includes('bot') || 
                error.includes('authentication')) {
              console.log(`🤖 Bot detection on ${strategy.name}`);
              // Don't reject immediately, let it try to complete
            }
          });
          
          ytdlp.on('close', (code) => {
            if (code === 0) {
              console.log(`✅ ${strategy.name} download succeeded`);
              strategyResolve();
            } else {
              console.log(`❌ ${strategy.name} failed with code ${code}`);
              strategyReject(new Error(`${strategy.name} failed`));
            }
          });
          
          // Strategy timeout
          setTimeout(() => {
            ytdlp.kill();
            strategyReject(new Error(`${strategy.name} timeout`));
          }, 600000); // 10 minutes per strategy
        });
        
        // Success!
        successfulDownloads++;
        downloadStatus.set(downloadId, { 
          status: 'completed',
          strategy: strategy.name
        });
        console.log(`✅ Download completed with ${strategy.name}: ${downloadId}`);
        resolve(downloadId);
        return;
        
      } catch (error) {
        console.log(`❌ ${strategy.name} download failed:`, error.message);
        downloadStatus.set(downloadId, {
          status: 'retrying',
          progress: 0,
          attempted_strategy: strategy.name,
          error: error.message
        });
        continue;
      }
    }
    
    // All strategies failed
    console.log('🤖 All download strategies failed');
    botDetectionIssue = true;
    downloadStatus.set(downloadId, { 
      status: 'error', 
      error: 'All download strategies failed. Bot detection active.',
      fallback: true,
      botDetected: true
    });
    reject(new Error('All download strategies failed'));
  });
};

// Enhanced command generation with even more strategies
app.post('/api/command', (req, res) => {
  try {
    const { url, quality } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    // Base command parts
    const qualityArgs = quality === 'audio' ? 
      '--extract-audio --audio-format mp3' : 
      quality !== 'best' ? `-f "${quality}"` : '';
    
    const outputArgs = '--output "%(title)s.%(ext)s"';
    
    // Multiple enhanced strategies
    const strategies = {
      basic: `yt-dlp ${qualityArgs} ${outputArgs} "${url}"`,
      
      webClient: `yt-dlp --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --extractor-args "youtube:player_client=web" ${qualityArgs} ${outputArgs} "${url}"`,
      
      androidClient: `yt-dlp --user-agent "com.google.android.youtube/17.36.4 (Linux; U; Android 12; GB) gzip" --extractor-args "youtube:player_client=android" ${qualityArgs} ${outputArgs} "${url}"`,
      
      iosClient: `yt-dlp --user-agent "com.google.ios.youtube/17.36.4 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)" --extractor-args "youtube:player_client=ios" ${qualityArgs} ${outputArgs} "${url}"`,
      
      withCookies: `yt-dlp --cookies-from-browser chrome ${qualityArgs} ${outputArgs} "${url}"`,
      
      aggressive: `yt-dlp --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --add-header "Accept-Language:en-US,en;q=0.9" --sleep-interval 2 --retries 5 --extractor-args "youtube:player_client=web" ${qualityArgs} ${outputArgs} "${url}"`,
      
      ultimate: `yt-dlp --cookies-from-browser chrome --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --add-header "Accept-Language:en-US,en;q=0.9" --sleep-interval 3 --retries 10 --fragment-retries 10 --extractor-args "youtube:player_client=web" ${qualityArgs} ${outputArgs} "${url}"`
    };
    
    // Clean up extra spaces
    Object.keys(strategies).forEach(key => {
      strategies[key] = strategies[key].replace(/\s+/g, ' ').trim();
    });
    
    const recommendedStrategy = botDetectionIssue ? 
      (successfulDownloads > 0 ? 'androidClient' : 'withCookies') : 'basic';
    
    res.json({
      success: true,
      command: strategies[recommendedStrategy],
      message: 'Enhanced anti-detection strategies generated',
      strategies: strategies,
      recommended: recommendedStrategy,
      instructions: `Recommended: "${recommendedStrategy}" strategy. Try in order: ${recommendedStrategy} → withCookies → ultimate`,
      troubleshooting: [
        '1. Install yt-dlp: pip install yt-dlp',
        '2. Try recommended strategy first',
        '3. If blocked: androidClient or iosClient',
        '4. For login videos: withCookies',
        '5. Nuclear option: ultimate (all bypasses)',
        '6. Last resort: Manual cookie export'
      ],
      server_stats: {
        bot_detection: botDetectionIssue,
        success_rate: directDownloadAttempts > 0 ? (successfulDownloads / directDownloadAttempts * 100).toFixed(1) + '%' : 'N/A',
        total_attempts: directDownloadAttempts,
        successful_downloads: successfulDownloads
      }
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ytdlp_available: ytDlpAvailable,
    ytdlp_path: ytDlpPath,
    bot_detection_issue: botDetectionIssue,
    download_stats: {
      attempts: directDownloadAttempts,
      successful: successfulDownloads,
      success_rate: directDownloadAttempts > 0 ? (successfulDownloads / directDownloadAttempts * 100).toFixed(1) + '%' : 'N/A'
    }
  });
});

app.get('/api/capabilities', (req, res) => {
  const canTryDirectDownload = ytDlpAvailable && (!botDetectionIssue || successfulDownloads > 0);
  
  res.json({
    ytdlp_available: ytDlpAvailable,
    ytdlp_path: ytDlpPath,
    bot_detection_issue: botDetectionIssue,
    can_try_direct_download: canTryDirectDownload,
    features: {
      video_info: ytDlpAvailable && !botDetectionIssue,
      video_download: canTryDirectDownload,
      command_generation: true,
      basic_info: true
    },
    download_stats: {
      attempts: directDownloadAttempts,
      successful: successfulDownloads,
      success_rate: directDownloadAttempts > 0 ? (successfulDownloads / directDownloadAttempts * 100).toFixed(1) + '%' : 'N/A'
    },
    limitations: botDetectionIssue ? [
      'YouTube bot detection detected',
      'Direct downloads may fail',
      'Command generation recommended',
      'Success rate: ' + (directDownloadAttempts > 0 ? (successfulDownloads / directDownloadAttempts * 100).toFixed(1) + '%' : 'Unknown')
    ] : []
  });
});

// Enhanced command generation with multiple bypass strategies
app.post('/api/command', (req, res) => {
  try {
    const { url, quality } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    // Basic command
    let baseCommand = 'yt-dlp ';
    
    if (quality === 'audio') {
      baseCommand += '--extract-audio --audio-format mp3 ';
    } else if (quality !== 'best') {
      baseCommand += `-f "${quality}" `;
    }
    
    baseCommand += '--output "%(title)s.%(ext)s" ';
    baseCommand += `"${url}"`;
    
    // Generate enhanced commands with different bypass strategies
    const enhancedCommands = {
      basic: baseCommand,
      
      antiDetection: baseCommand.replace('yt-dlp ', 
        'yt-dlp --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --sleep-interval 1 '),
      
      withCookies: baseCommand.replace('yt-dlp ', 
        'yt-dlp --cookies-from-browser chrome '),
      
      alternative: baseCommand.replace('yt-dlp ', 
        'yt-dlp --extractor-args "youtube:player_client=web" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" '),
      
      aggressive: baseCommand.replace('yt-dlp ', 
        'yt-dlp --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --add-header "Accept-Language:en-US,en;q=0.9" --sleep-interval 2 --retries 5 --extractor-args "youtube:player_client=web" ')
    };
    
    res.json({
      success: true,
      command: enhancedCommands.basic,
      message: 'Multiple bypass strategies generated',
      strategies: enhancedCommands,
      recommended: botDetectionIssue ? 'antiDetection' : 'basic',
      instructions: botDetectionIssue ? 
        'Bot detection detected. Try "antiDetection" or "withCookies" commands first.' :
        'Try commands in order: basic → antiDetection → withCookies → alternative → aggressive',
      troubleshooting: [
        '1. Install yt-dlp: pip install yt-dlp',
        '2. Try recommended command first',
        '3. If blocked, try "withCookies" version',
        '4. For persistent issues: use "aggressive" strategy',
        '5. Last resort: --cookies-from-browser firefox'
      ],
      server_stats: {
        bot_detection: botDetectionIssue,
        success_rate: directDownloadAttempts > 0 ? (successfulDownloads / directDownloadAttempts * 100).toFixed(1) + '%' : 'N/A'
      }
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
    
    // Always try to get basic info first
    const basicInfo = getBasicVideoInfo(url);
    
    if (!ytDlpAvailable || botDetectionIssue) {
      res.json({ 
        success: true, 
        ...basicInfo,
        message: botDetectionIssue ? 
          'Bot detection limits video info. Command generation works!' :
          'Basic video info only. Command generation available.'
      });
      return;
    }
    
    // Try to get detailed info with anti-detection
    try {
      const detailedInfo = await getVideoInfo(url);
      res.json({ 
        success: true, 
        ...detailedInfo,
        message: 'Video info retrieved successfully'
      });
    } catch (error) {
      // Fallback to basic info if detailed info fails
      res.json({ 
        success: true, 
        ...basicInfo,
        message: 'Using basic video info. Detailed info failed.',
        error: error.message
      });
    }
    
  } catch (error) {
    console.error('Video info error:', error);
    res.status(400).json({ 
      success: false,
      error: error.message
    });
  }
});

// Start download with hybrid approach
app.post('/api/download', async (req, res) => {
  try {
    const { url, quality } = req.body;
    
    if (!url) {
      return res.status(400).json({ 
        success: false, 
        error: 'URL is required' 
      });
    }
    
    const canTryDirectDownload = ytDlpAvailable && (!botDetectionIssue || successfulDownloads > 0);
    
    if (!canTryDirectDownload) {
      return res.status(503).json({ 
        success: false, 
        error: 'Direct download not recommended due to bot detection. Use command generation.',
        fallback: true,
        suggestion: 'Click "Generate Command" for reliable local download',
        reason: 'YouTube bot detection active'
      });
    }
    
    const downloadId = uuidv4();
    downloadStatus.set(downloadId, { status: 'starting' });
    
    // Start download in background with anti-detection
    downloadVideo(url, quality, downloadId).catch(err => {
      console.error('Download error:', err);
      downloadStatus.set(downloadId, { 
        status: 'error', 
        error: err.message,
        fallback: true,
        botDetected: botDetectionIssue
      });
    });
    
    res.json({ 
      success: true, 
      downloadId,
      message: 'Download started with anti-detection measures',
      warning: botDetectionIssue ? 'Bot detection detected. Download may fail.' : null
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Check download status
app.get('/api/status/:downloadId', (req, res) => {
  const { downloadId } = req.params;
  const status = downloadStatus.get(downloadId);
  
  if (!status) {
    return res.status(404).json({ 
      error: 'Download not found' 
    });
  }
  
  res.json(status);
});

// Download file
app.get('/api/file/:downloadId', async (req, res) => {
  try {
    const { downloadId } = req.params;
    const status = downloadStatus.get(downloadId);
    
    if (!status || status.status !== 'completed') {
      return res.status(404).json({ 
        error: 'File not ready' 
      });
    }
    
    // Find the downloaded file
    const files = await fs.readdir(TEMP_DIR);
    const downloadedFile = files.find(file => file.startsWith(downloadId));
    
    if (!downloadedFile) {
      return res.status(404).json({ 
        error: 'File not found' 
      });
    }
    
    const filePath = path.join(TEMP_DIR, downloadedFile);
    const stats = await fs.stat(filePath);
    
    // Set headers for download
    const cleanFilename = downloadedFile.replace(downloadId + '.', '');
    res.setHeader('Content-Disposition', `attachment; filename="${cleanFilename}"`);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    // Stream the file
    const fileStream = require('fs').createReadStream(filePath);
    fileStream.pipe(res);
    
    // Cleanup after download
    fileStream.on('end', async () => {
      try {
        await fs.unlink(filePath);
        downloadStatus.delete(downloadId);
        console.log(`🧹 Cleaned up: ${downloadedFile}`);
      } catch (err) {
        console.error('Cleanup error:', err);
      }
    });
    
  } catch (error) {
    res.status(500).json({ 
      error: error.message 
    });
  }
});

// Cleanup old downloads every hour
setInterval(async () => {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = await fs.stat(filePath);
      
      // Delete files older than 1 hour
      if (now - stats.mtime.getTime() > 60 * 60 * 1000) {
        await fs.unlink(filePath);
        console.log(`🧹 Auto-cleaned: ${file}`);
      }
    }
  } catch (error) {
    console.error('Auto-cleanup error:', error);
  }
}, 60 * 60 * 1000);

// Serve main app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize server with quick startup
const startServer = async () => {
  console.log('🚀 Starting YouTube Downloader with Hybrid Anti-Detection...');
  
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
        console.log(`🤖 Bot detection detected - Hybrid mode enabled`);
        console.log(`💡 Direct downloads may work with anti-detection measures`);
        console.log(`📋 Command generation is the reliable fallback`);
      } else {
        console.log(`📱 yt-dlp status: ${ytDlpAvailable ? 'Available with anti-detection' : 'Command generation mode'}`);
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
