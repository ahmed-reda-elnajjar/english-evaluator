require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const Groq    = require('groq-sdk');
const ffmpeg  = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const sdk  = require('microsoft-cognitiveservices-speech-sdk');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const groq   = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Audio conversion ───────────────────────────────────────

function convertToWav16k(inputBuffer, ext) {
  return new Promise((resolve, reject) => {
    const tmpIn  = path.join(os.tmpdir(), `spk_in_${Date.now()}.${ext}`);
    const tmpOut = path.join(os.tmpdir(), `spk_out_${Date.now()}.wav`);
    fs.writeFileSync(tmpIn, inputBuffer);
    ffmpeg(tmpIn)
      .audioFrequency(16000).audioChannels(1).audioCodec('pcm_s16le').format('wav')
      .on('end', () => {
        const wav = fs.readFileSync(tmpOut);
        fs.unlink(tmpIn, () => {}); fs.unlink(tmpOut, () => {});
        resolve(wav);
      })
      .on('error', err => {
        fs.unlink(tmpIn, () => {}); fs.unlink(tmpOut, () => {});
        reject(err);
      })
      .save(tmpOut);
  });
}

function getExt(mime = '') {
  if (mime.includes('ogg'))  return 'ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'mp4';
  if (mime.includes('mp3') || mime.includes('mpeg')) return 'mp3';
  if (mime.includes('wav'))  return 'wav';
  return 'webm';
}

function avg(arr) {
  const valid = arr.filter(v => v != null && !isNaN(v));
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
}

// ── Azure Speech SDK — matches Speech Studio exactly ───────

function assessWithSDK(wavBuffer, azureKey, azureRegion) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    // Safety timeout — 120 seconds
    const timer = setTimeout(() => settle(reject, new Error('Azure SDK timeout after 120s')), 120000);

    // Validate WAV buffer
    if (!wavBuffer || wavBuffer.length < 44) {
      clearTimeout(timer);
      return reject(new Error('WAV buffer too small or missing'));
    }

    // Parse WAV header for actual format
    const sampleRate    = wavBuffer.readUInt32LE(24);
    const channels      = wavBuffer.readUInt16LE(22);
    const bitsPerSample = wavBuffer.readUInt16LE(34);
    const pcmData       = wavBuffer.slice(44);
    console.log(`WAV: ${sampleRate}Hz ${channels}ch ${bitsPerSample}bit — ${pcmData.length} bytes PCM`);

    if (pcmData.length < 8000) {
      clearTimeout(timer);
      return reject(new Error('Recording too short — please speak for at least 1 second'));
    }

    // Build SDK objects
    const format     = sdk.AudioStreamFormat.getWaveFormatPCM(sampleRate, bitsPerSample, channels);
    const pushStream = sdk.AudioInputStream.createPushStream(format);
    pushStream.write(pcmData);
    pushStream.close();

    const speechConfig = sdk.SpeechConfig.fromSubscription(azureKey, azureRegion);
    speechConfig.speechRecognitionLanguage = 'en-US';

    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);

    const paConfig = new sdk.PronunciationAssessmentConfig(
      '',
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Word,
      false
    );
    // enableContentAssessment() not available in this SDK version — use updateJson instead
    const configJson = JSON.parse(paConfig.toJSON());
    configJson.EnableContentAssessment = true;
    paConfig.updateJson(JSON.stringify(configJson));
    console.log('Assessment config:', paConfig.toJSON());

    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    paConfig.applyTo(recognizer);

    const segments = [];
    const words    = [];

    recognizer.recognized = (s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
        const pa = sdk.PronunciationAssessmentResult.fromResult(e.result);
        segments.push({
          text:  e.result.text,
          pron:  pa.pronunciationScore      ?? 0,
          acc:   pa.accuracyScore           ?? 0,
          flu:   pa.fluencyScore            ?? 0,
          comp:  pa.completenessScore       ?? 0,
          gram:  pa.contentAssessmentResult?.grammarScore    ?? null,
          voc:   pa.contentAssessmentResult?.vocabularyScore ?? null,
          topic: pa.contentAssessmentResult?.topicScore      ?? null,
        });

        // Word-level data
        const ws = pa.detailResult?.words || [];
        ws.forEach(w => words.push({
          word:     w.word,
          accuracy: Math.round(w.pronunciationAssessment?.accuracyScore ?? 100),
          error:    w.pronunciationAssessment?.errorType ?? 'None',
        }));

        console.log(`  Segment: pron=${pa.pronunciationScore?.toFixed(0)} flu=${pa.fluencyScore?.toFixed(0)} gram=${pa.contentAssessmentResult?.grammarScore ?? '-'} voc=${pa.contentAssessmentResult?.vocabularyScore ?? '-'}`);
      }
    };

    // Called when all audio has been processed
    const finish = () => {
      clearTimeout(timer);
      try { recognizer.close(); } catch {}

      if (segments.length === 0) {
        settle(reject, new Error('No speech recognized — please speak clearly in English'));
        return;
      }

      const transcript = segments.map(s => s.text).join(' ');

      // Average acoustic scores across all segments
      const pronScore = Math.round(avg(segments.map(s => s.pron)));
      const accScore  = Math.round(avg(segments.map(s => s.acc)));
      const fluScore  = Math.round(avg(segments.map(s => s.flu)));
      const compScore = Math.round(avg(segments.map(s => s.comp)));

      // Content scores — last non-null value (Azure fills at end of session)
      const gramScore  = Math.round(segments.map(s => s.gram).filter(v => v != null).pop() ?? 0);
      const vocScore   = Math.round(segments.map(s => s.voc).filter(v => v != null).pop()  ?? 0);
      const topicScore = Math.round(segments.map(s => s.topic).filter(v => v != null).pop() ?? 0);

      console.log(`✅ Final: pron=${pronScore} acc=${accScore} flu=${fluScore} gram=${gramScore} voc=${vocScore} words=${words.length}`);

      settle(resolve, {
        transcript,
        pronunciationScore: pronScore,
        accuracyScore:      accScore,
        fluencyScore:       fluScore,
        completenessScore:  compScore,
        grammarScore:       gramScore,
        vocabularyScore:    vocScore,
        topicScore,
        words,
      });
    };

    recognizer.sessionStopped = () => finish();

    recognizer.canceled = (s, e) => {
      if (e.reason === sdk.CancellationReason.Error) {
        clearTimeout(timer);
        try { recognizer.close(); } catch {}
        console.error('Azure SDK canceled with error:', e.errorDetails);
        settle(reject, new Error(`Azure SDK: ${e.errorDetails}`));
      } else {
        // EndOfStream — normal completion
        finish();
      }
    };

    recognizer.startContinuousRecognitionAsync(
      () => console.log('Azure SDK: recognition started…'),
      err => {
        clearTimeout(timer);
        try { recognizer.close(); } catch {}
        settle(reject, new Error(`SDK start failed: ${err}`));
      }
    );
  });
}

// ── JSON helper ────────────────────────────────────────────

function extractJSON(text) {
  try { return JSON.parse(text); } catch {}
  const block = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (block) return JSON.parse(block[1]);
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) return JSON.parse(obj[0]);
  throw new Error('No valid JSON in Groq response');
}

// ── Main endpoint ──────────────────────────────────────────

app.post('/api/analyze', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file received' });

    const azureRegion = process.env.AZURE_SPEECH_REGION;
    const azureKey    = process.env.AZURE_SPEECH_KEY;
    if (!azureRegion || !azureKey)
      return res.status(500).json({ error: 'Azure credentials not configured in .env' });

    // ── 1. Ensure WAV 16kHz ───────────────────────────────
    let wavBuffer;
    const mime  = (req.file.mimetype || '').toLowerCase();
    const fname = (req.file.originalname || '').toLowerCase();
    const isWav = (mime.includes('wav') || fname.endsWith('.wav'));

    if (isWav) {
      wavBuffer = req.file.buffer;
      console.log(`Already WAV (${wavBuffer.length} bytes)`);
    } else {
      try {
        const ext = getExt(mime || fname);
        console.log(`Converting (${mime}, ${req.file.size}B) → WAV…`);
        wavBuffer = await convertToWav16k(req.file.buffer, ext);
        console.log(`Converted: ${wavBuffer.length} bytes`);
      } catch (e) {
        return res.status(422).json({ error: 'Could not process audio file.', details: e.message });
      }
    }

    // ── 2. Azure SDK assessment ───────────────────────────
    let azure;
    try {
      azure = await assessWithSDK(wavBuffer, azureKey, azureRegion);
    } catch (e) {
      console.error('Azure SDK error:', e.message);
      return res.status(502).json({ error: 'Azure assessment failed', details: e.message });
    }

    if (!azure.transcript || azure.transcript.trim().length < 5)
      return res.status(422).json({ error: 'Could not transcribe audio. Please speak clearly in English.' });

    // ── 3. Groq: feedback text + CEFR (scores from Azure) ─
    const prompt = `You are an expert English Language Evaluator certified in CEFR grading.

These scores were computed by Azure Speech AI — treat them as absolute ground truth:
- Pronunciation Score : ${azure.pronunciationScore}/100
- Fluency Score       : ${azure.fluencyScore}/100
- Accuracy Score      : ${azure.accuracyScore}/100
- Grammar Score       : ${azure.grammarScore}/100   ← Azure Content Assessment
- Vocabulary Score    : ${azure.vocabularyScore}/100 ← Azure Content Assessment

Speech Transcript (Azure Speech-to-Text):
"${azure.transcript}"

Your ONLY tasks:
1. grammar_feedback: 2-3 sentences about specific grammar errors and strengths in the transcript.
2. vocabulary_feedback: 2-3 sentences about word choice, range, and lexical variety.
3. overall_cefr_level: ONE level based on ALL Azure scores above.
4. final_evaluation_summary: 2-3 sentences referencing the actual score numbers.

Available CEFR Levels (choose ONLY ONE): A1, A2, A2+, B1, B1+, B2, B2+, C1, C1+, C2

Return ONLY valid JSON — no markdown:
{
  "grammar_feedback": "...",
  "vocabulary_feedback": "...",
  "overall_cefr_level": "...",
  "final_evaluation_summary": "..."
}`;

    let evaluation;
    try {
      const r = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 800,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      });
      evaluation = extractJSON(r.choices[0].message.content);
    } catch (e) {
      console.error('Groq error:', e.message);
      return res.status(502).json({ error: 'Groq API failed', details: e.message });
    }

    // ── 4. Send response ──────────────────────────────────
    res.json({
      transcript: azure.transcript,
      words:      azure.words,
      azure_scores: {
        pronunciation: azure.pronunciationScore,
        fluency:       azure.fluencyScore,
        accuracy:      azure.accuracyScore,
        completeness:  azure.completenessScore,
      },
      grammar_score_out_of_100:    azure.grammarScore,
      vocabulary_score_out_of_100: azure.vocabularyScore,
      grammar_feedback:            evaluation.grammar_feedback,
      vocabulary_feedback:         evaluation.vocabulary_feedback,
      overall_cefr_level:          evaluation.overall_cefr_level,
      final_evaluation_summary:    evaluation.final_evaluation_summary,
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n✅ English Evaluator running at http://localhost:${PORT}\n`));
