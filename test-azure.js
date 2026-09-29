require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Create a simple test WAV (sine wave) using ffmpeg
function makeTestWav() {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), 'test_azure.wav');
    ffmpeg()
      .input('sine=frequency=440:duration=3')
      .inputFormat('lavfi')
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', () => resolve(fs.readFileSync(out)))
      .on('error', reject)
      .save(out);
  });
}

async function test() {
  const region = process.env.AZURE_SPEECH_REGION;
  const key    = process.env.AZURE_SPEECH_KEY;

  console.log('Region:', region);
  console.log('Key prefix:', key?.slice(0, 8) + '...');

  const assessmentHeader = Buffer.from(JSON.stringify({
    GradingSystem: 'HundredMark',
    Granularity: 'FullText',
    EnableContentAssessment: true
  })).toString('base64');

  // Try with a real English speech WAV if available, else generate tone
  let wavBuffer;
  const testFile = path.join(__dirname, 'test.wav');
  if (fs.existsSync(testFile)) {
    console.log('Using test.wav');
    wavBuffer = fs.readFileSync(testFile);
  } else {
    console.log('Generating test tone WAV...');
    wavBuffer = await makeTestWav();
  }

  console.log('WAV size:', wavBuffer.length, 'bytes');

  try {
    const resp = await axios.post(
      `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`,
      wavBuffer,
      {
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
          'Pronunciation-Assessment': assessmentHeader,
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 30000,
      }
    );
    console.log('\n✅ Azure Response:');
    console.log(JSON.stringify(resp.data, null, 2));
  } catch (err) {
    console.error('\n❌ Azure Error:');
    console.error('Status:', err.response?.status);
    console.error('Data:', JSON.stringify(err.response?.data, null, 2));
    console.error('Message:', err.message);
  }
}

test();
