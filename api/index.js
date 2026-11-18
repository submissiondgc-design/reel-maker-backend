const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Persistent store helper (supports Upstash/Vercel KV or local /tmp fallback)
const MEMORY_STORE = new Map();
const TMP_FILE = path.join('/tmp', 'rmw_jobs.json');

async function getJob(id) {
  // 1. Try Upstash / Vercel KV if env configured
  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (kvUrl && kvToken) {
    try {
      const res = await fetch(`${kvUrl}/get/${id}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      const data = await res.json();
      if (data && data.result) {
        return typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
      }
    } catch (err) {
      console.error('KV get error:', err);
    }
  }

  // 2. Try in-memory
  if (MEMORY_STORE.has(id)) {
    return MEMORY_STORE.get(id);
  }

  // 3. Try /tmp file store
  try {
    if (fs.existsSync(TMP_FILE)) {
      const all = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
      if (all[id]) {
        MEMORY_STORE.set(id, all[id]);
        return all[id];
      }
    }
  } catch (e) {}

  return null;
}

async function saveJob(id, data) {
  MEMORY_STORE.set(id, data);

  // 1. Try Upstash / Vercel KV if configured
  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (kvUrl && kvToken) {
    try {
      const encodedValue = encodeURIComponent(JSON.stringify(data));
      await fetch(`${kvUrl}/set/${encodeURIComponent(id)}/${encodedValue}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
    } catch (err) {
      console.error('KV set error:', err);
    }
  }

  // 2. Save to /tmp fallback
  try {
    let all = {};
    if (fs.existsSync(TMP_FILE)) {
      try {
        all = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
      } catch (e) {}
    }
    all[id] = data;
    fs.writeFileSync(TMP_FILE, JSON.stringify(all));
  } catch (e) {}
}

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Reel Maker Processing Backend',
    status: 'online',
    endpoints: {
      health: 'GET /health?service=groq|assemblyai|shotstack|youtube',
      create_job: 'POST /jobs',
      poll_job: 'GET /jobs/:id'
    }
  });
});

// 1. Health check endpoint
app.get('/health', async (req, res) => {
  const service = (req.query.service || '').toLowerCase().trim();

  // Extract headers
  const groqKey = req.headers['x-groq-api-key'] || req.headers['x-xai-api-key'] || process.env.GROQ_API_KEY;
  const assemblyAiKey = req.headers['x-assemblyai-api-key'] || process.env.ASSEMBLYAI_API_KEY;
  const shotstackKey = req.headers['x-shotstack-api-key'] || process.env.SHOTSTACK_API_KEY;
  const youtubeKey = req.headers['x-youtube-api-key'] || process.env.YOUTUBE_API_KEY;
  const shotstackEnv = (req.headers['x-shotstack-environment'] || 'stage').toLowerCase();

  if (!service) {
    return res.json({ ok: true, status: 'ok', message: 'Backend is healthy.' });
  }

  try {
    if (service === 'groq' || service === 'xai') {
      if (!groqKey) {
        return res.status(400).json({ ok: false, message: 'Groq API Key is missing.' });
      }
      const testRes = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${groqKey}` }
      });
      if (testRes.ok) {
        return res.json({ ok: true, service: 'groq', message: 'Groq connected successfully.' });
      } else {
        const errData = await testRes.json().catch(() => ({}));
        return res.status(401).json({
          ok: false,
          message: errData.error?.message || 'Groq connection failed. Check your API key.'
        });
      }
    }

    if (service === 'assemblyai') {
      if (!assemblyAiKey) {
        return res.status(400).json({ ok: false, message: 'AssemblyAI API Key is missing.' });
      }
      // Ping AssemblyAI
      const testRes = await fetch('https://api.assemblyai.com/v2/transcript?limit=1', {
        headers: { Authorization: assemblyAiKey }
      });
      if (testRes.ok) {
        return res.json({ ok: true, service: 'assemblyai', message: 'AssemblyAI connected successfully.' });
      } else {
        const errData = await testRes.json().catch(() => ({}));
        return res.status(401).json({
          ok: false,
          message: errData.error || 'AssemblyAI connection failed. Check your API key.'
        });
      }
    }

    if (service === 'shotstack') {
      if (!shotstackKey) {
        return res.status(400).json({ ok: false, message: 'Shotstack API Key is missing.' });
      }
      const stage = shotstackEnv === 'production' ? 'v1' : 'stage';
      // Verify the key with Shotstack's authenticated templates endpoint.
      const testRes = await fetch(`https://api.shotstack.io/edit/${stage}/templates`, {
        headers: { 'x-api-key': shotstackKey }
      });
      if (testRes.ok) {
        return res.json({ ok: true, service: 'shotstack', message: 'Shotstack connected successfully.' });
      }
      const errData = await testRes.json().catch(() => ({}));
      const detail = errData.errors?.[0]?.detail || errData.message || 'Shotstack connection failed. Check your API key and environment.';
      return res.status(401).json({ ok: false, message: detail });
    }

    if (service === 'youtube') {
      if (!youtubeKey) {
        return res.status(400).json({ ok: false, message: 'YouTube API Key is missing.' });
      }
      const testRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videoCategories?part=snippet&regionCode=US&key=${youtubeKey}`
      );
      if (testRes.ok) {
        return res.json({ ok: true, service: 'youtube', message: 'YouTube API connected successfully.' });
      } else {
        const errData = await testRes.json().catch(() => ({}));
        return res.status(401).json({
          ok: false,
          message: errData.error?.message || 'YouTube connection failed. Check your API key.'
        });
      }
    }

    return res.status(400).json({ ok: false, message: `Unknown service: ${service}` });
  } catch (error) {
    return res.status(502).json({ ok: false, message: error.message || 'Health check error' });
  }
});

// 2. Start Job endpoint
app.post('/jobs', async (req, res) => {
  try {
    const { youtube_url, video_url, shotstack_environment, rights_confirmed } = req.body;

    if (!rights_confirmed) {
      return res.status(400).json({ ok: false, message: 'Video rights must be confirmed.' });
    }

    if (youtube_url && !video_url) {
      if (youtube_url.includes('youtube.com') || youtube_url.includes('youtu.be')) {
        return res.status(400).json({
          ok: false,
          message: 'YouTube watch links cannot be read directly by AssemblyAI or Shotstack. Please upload the video file (MP4/MOV) directly using the upload field.'
        });
      }
    }

    const targetUrl = video_url || youtube_url;
    if (!targetUrl) {
      return res.status(400).json({ ok: false, message: 'Provide either a video_url or youtube_url.' });
    }

    const groqKey = req.headers['x-groq-api-key'] || req.headers['x-xai-api-key'] || process.env.GROQ_API_KEY;
    const assemblyAiKey = req.headers['x-assemblyai-api-key'] || process.env.ASSEMBLYAI_API_KEY;
    const shotstackKey = req.headers['x-shotstack-api-key'] || process.env.SHOTSTACK_API_KEY;
    const shotstackEnv = (shotstack_environment || req.headers['x-shotstack-environment'] || 'stage').toLowerCase();

    if (!assemblyAiKey) {
      return res.status(400).json({ ok: false, message: 'AssemblyAI API Key required for transcription.' });
    }

    // Submit transcription request to AssemblyAI
    const aaiRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        Authorization: assemblyAiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        audio_url: targetUrl,
        auto_highlights: true,
        speaker_labels: false
      })
    });

    const aaiData = await aaiRes.json();
    if (!aaiRes.ok || !aaiData.id) {
      return res.status(502).json({
        ok: false,
        message: aaiData.error || 'Failed to submit audio to AssemblyAI.'
      });
    }

    const jobId = 'rmw_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

    const job = {
      id: jobId,
      status: 'transcribing',
      assemblyai_id: aaiData.id,
      video_url: targetUrl,
      // Credentials are never persisted; WordPress sends them again when polling.
      shotstack_env: shotstackEnv,
      clips: [],
      created_at: new Date().toISOString()
    };

    await saveJob(jobId, job);

    return res.status(200).json({
      job_id: jobId,
      id: jobId,
      status: 'queued'
    });
  } catch (error) {
    console.error('Error starting job:', error);
    return res.status(500).json({ ok: false, message: error.message || 'Internal error starting job.' });
  }
});

// Helper: Ask Groq for best highlight timestamps
async function pickMomentsWithGroq(groqKey, transcriptText) {
  if (!groqKey) {
    // Fallback: 1 default 30s moment if Groq is not configured
    return [
      {
        title: 'Highlight Reel',
        start: 0,
        end: 30
      }
    ];
  }

  const prompt = `You are a social media reel editor. Analyze this video transcript and select 1 to 3 viral, engaging moments suitable for 9:16 short-form video reels (TikTok, YouTube Shorts, Instagram Reels).
Each clip should be between 15 and 45 seconds long.

Transcript:
${transcriptText.slice(0, 8000)}

Return ONLY a valid JSON array of objects with keys "title" (catchy hook), "start" (start in seconds, number), and "end" (end in seconds, number). Example:
[{"title": "The Biggest Secret", "start": 12, "end": 42}]`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    return [{ title: 'Featured Moment', start: 0, end: 30 }];
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(content);
    const moments = Array.isArray(parsed) ? parsed : (parsed.moments || parsed.clips || Object.values(parsed)[0]);
    if (Array.isArray(moments) && moments.length > 0) {
      return moments.slice(0, 3).map(m => ({
        title: m.title || 'Highlight Reel',
        start: Math.max(0, Number(m.start) || 0),
        end: Math.max((Number(m.start) || 0) + 10, Number(m.end) || (Number(m.start) || 0) + 30)
      }));
    }
  } catch (e) {}

  return [{ title: 'Featured Moment', start: 0, end: 30 }];
}

// Helper: Submit Shotstack render for vertical reel
async function renderWithShotstack(shotstackKey, shotstackEnv, videoUrl, moment) {
  if (!shotstackKey) {
    // If no shotstack key, return original video as dummy clip
    return {
      title: moment.title,
      url: videoUrl
    };
  }

  const stage = shotstackEnv === 'production' ? 'v1' : 'stage';
  const duration = Math.min(60, Math.max(5, moment.end - moment.start));

  const shotstackPayload = {
    timeline: {
      background: '#000000',
      tracks: [
        {
          clips: [
            {
              asset: {
                type: 'title',
                text: moment.title,
                style: 'blockbuster',
                size: 'small',
                position: 'top'
              },
              start: 0,
              length: Math.min(5, duration)
            }
          ]
        },
        {
          clips: [
            {
              asset: {
                type: 'video',
                src: videoUrl,
                trim: moment.start
              },
              start: 0,
              length: duration,
              fit: 'cover'
            }
          ]
        }
      ]
    },
    output: {
      format: 'mp4',
      resolution: '1080',
      aspectRatio: '9:16',
      fps: 30
    }
  };

  const res = await fetch(`https://api.shotstack.io/edit/${stage}/render`, {
    method: 'POST',
    headers: {
      'x-api-key': shotstackKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(shotstackPayload)
  });

  const data = await res.json();
  if (res.ok && data.response?.id) {
    return {
      render_id: data.response.id,
      title: moment.title
    };
  } else {
    throw new Error(data.message || 'Shotstack render dispatch failed.');
  }
}

// 3. Poll Job Status
app.get('/jobs/:id', async (req, res) => {
  try {
    const jobId = req.params.id;
    const job = await getJob(jobId);

    if (!job) {
      return res.status(404).json({ ok: false, status: 'failed', message: 'Job not found.' });
    }

    // Step A: If transcribing, check AssemblyAI status
    if (job.status === 'transcribing' || job.status === 'queued') {
      const assemblyAiKey = req.headers['x-assemblyai-api-key'] || process.env.ASSEMBLYAI_API_KEY;
      const aaiRes = await fetch(`https://api.assemblyai.com/v2/transcript/${job.assemblyai_id}`, {
        headers: { Authorization: assemblyAiKey }
      });
      const aaiData = await aaiRes.json();

      if (aaiData.status === 'queued' || aaiData.status === 'processing') {
        return res.json({ status: 'transcribing' });
      }

      if (aaiData.status === 'error') {
        job.status = 'failed';
        job.message = aaiData.error || 'AssemblyAI transcription failed.';
        await saveJob(jobId, job);
        return res.json({ status: 'failed', message: job.message });
      }

      if (aaiData.status === 'completed') {
        // Step B: Moments selection with Groq
        job.status = 'selecting_moments';
        await saveJob(jobId, job);

        const groqKey = req.headers['x-groq-api-key'] || req.headers['x-xai-api-key'] || process.env.GROQ_API_KEY;
        const moments = await pickMomentsWithGroq(groqKey, aaiData.text || '');

        // Step C: Trigger Shotstack render
        const shotstackKey = req.headers['x-shotstack-api-key'] || process.env.SHOTSTACK_API_KEY;
        const shotstackEnv = job.shotstack_env || 'stage';

        try {
          const renders = [];
          for (const m of moments.slice(0, 2)) {
            const renderResult = await renderWithShotstack(shotstackKey, shotstackEnv, job.video_url, m);
            renders.push(renderResult);
          }

          // If shotstack is bypassed or completed immediately
          const isAllDone = renders.every(r => r.url);
          if (isAllDone) {
            job.status = 'done';
            job.clips = renders;
          } else {
            job.status = 'rendering';
            job.pending_renders = renders;
          }
          await saveJob(jobId, job);

          return res.json({ status: job.status });
        } catch (renderErr) {
          job.status = 'failed';
          job.message = renderErr.message;
          await saveJob(jobId, job);
          return res.json({ status: 'failed', message: renderErr.message });
        }
      }
    }

    // Step D: If rendering, check Shotstack render status
    if (job.status === 'rendering') {
      const shotstackKey = req.headers['x-shotstack-api-key'] || process.env.SHOTSTACK_API_KEY;
      const stage = (job.shotstack_env || 'stage') === 'production' ? 'v1' : 'stage';

      let allDone = true;
      const completedClips = [];

      for (const render of job.pending_renders || []) {
        if (render.url) {
          completedClips.push({ title: render.title, url: render.url });
          continue;
        }

        const renderRes = await fetch(`https://api.shotstack.io/edit/${stage}/render/${render.render_id}`, {
          headers: { 'x-api-key': shotstackKey }
        });
        const renderData = await renderRes.json();

        if (renderData.response?.status === 'done' && renderData.response?.url) {
          completedClips.push({ title: render.title, url: renderData.response.url });
        } else if (renderData.response?.status === 'failed') {
          job.status = 'failed';
          job.message = 'Video rendering failed on Shotstack.';
          await saveJob(jobId, job);
          return res.json({ status: 'failed', message: job.message });
        } else {
          allDone = false;
        }
      }

      if (allDone && completedClips.length > 0) {
        job.status = 'done';
        job.clips = completedClips;
        await saveJob(jobId, job);
        return res.json({ status: 'done', clips: job.clips });
      }

      return res.json({ status: 'rendering' });
    }

    if (job.status === 'done') {
      return res.json({ status: 'done', clips: job.clips || [] });
    }

    if (job.status === 'failed') {
      return res.json({ status: 'failed', message: job.message || 'Job processing failed.' });
    }

    return res.json({ status: job.status });
  } catch (error) {
    console.error('Error polling job:', error);
    return res.status(500).json({ ok: false, message: error.message || 'Error checking job status.' });
  }
});

module.exports = app;
