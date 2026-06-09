// Speech I/O for Newrosama.
//
// Two TTS providers, used in this priority order:
//   1. VOICEVOX (enabled in Settings) — high-quality anime-character voice,
//      requires the VOICEVOX app running locally on port 50021.
//      Only activates for Japanese; other languages fall through to provider 2.
//   2. Browser SpeechSynthesis — built-in, free, works everywhere, no setup.
//
// STT uses the browser's SpeechRecognition API (Chrome / Edge only).

export const LANGUAGES = {
  ko:    { code: 'ko-KR', label: '한국어' },
  ja:    { code: 'ja-JP', label: '日本語' },
  en:    { code: 'en-US', label: 'English' },
  // Mixed English-Japanese: ja-JP engine handles EN/JA code-switching well.
  // The brain detects the dominant language and replies accordingly.
  multi: { code: 'ja-JP', label: 'EN+JA' },
};

export const VOICE_PERSONAS = {
  girl: {
    label: '발랄한 소녀',
    pitch: 1.15,
    rate: 1.02,
    hints: [
      'female', 'woman', 'girl',
      'kyoko', 'o-ren', 'haruka', 'sayaka', 'ayumi', 'nanami', 'mizuki', 'yuna', 'madoka',
      'google 日本語', 'google uk english female', 'google us english',
      'siri', 'samantha', 'sora',
    ],
  },
  jarvis: {
    label: '차분한 집사 AI (JARVIS 스타일)',
    pitch: 0.86,
    rate: 0.95,
    hints: [
      'male', 'man', 'daniel', 'george', 'ryan', 'arthur', 'oliver', 'fred',
      'aaron', 'guy', 'gordon', 'james', 'alex',
      'google uk english male', 'microsoft george', 'microsoft ryan',
    ],
  },
};

// VOICEVOX configuration.
// Speaker 14 = 冥鳴ひまり (ノーマル) — selected for Mao.
//
// mode:
//   'off'            — never use VOICEVOX, just the browser voice
//   'web'            — hosted VOICEVOX over HTTPS (api.tts.quest). Works on a
//                      phone/tablet + GitHub Pages. No install needed.
//                      ★ default for the web/tablet demo. Optional key = faster.
//   'local'          — VOICEVOX desktop app on http://localhost:50021.
//                      Highest quality + instant, but desktop only.
const VOICEVOX_DEFAULTS = {
  mode: 'web',
  speakerId: 14,
  localEndpoint: 'http://localhost:50021',
  webEndpoint: 'https://api.tts.quest/v3/voicevox/synthesis',
  webKey: '', // optional tts.quest key; set via Settings, never committed
};

function pickBrowserVoice(langCode, persona) {
  const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  if (!voices.length) return null;

  const base = langCode.split('-')[0];
  const sameLang = voices.filter((v) => v.lang === langCode);
  const sameBase = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  const pool = sameLang.length ? sameLang : sameBase.length ? sameBase : voices;

  const hints = (VOICE_PERSONAS[persona] || VOICE_PERSONAS.girl).hints;
  const matched = pool.find((v) =>
    hints.some((hint) => v.name.toLowerCase().includes(hint))
  );
  return matched || pool[0];
}

export class SpeechController {
  constructor({ onResult, onListenChange, onSpeakChange, onError } = {}) {
    const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!SpeechRecognitionImpl;
    this.lang = 'ja';
    this.persona = 'girl';
    this.onSpeakChange = onSpeakChange;
    this.onError = onError;
    this.voicevox = { ...VOICEVOX_DEFAULTS };

    if (this.supported) {
      this.recognition = new SpeechRecognitionImpl();
      this.recognition.continuous = false;
      this.recognition.interimResults = false;
      this.recognition.maxAlternatives = 1;

      this.recognition.onresult = (event) => {
        const last = event.results[event.results.length - 1];
        const text = last[0].transcript.trim();
        if (text) onResult?.(text);
      };
      this.recognition.onend = () => onListenChange?.(false);
      this.recognition.onerror = (event) => {
        onListenChange?.(false);
        onError?.(event.error);
      };
    }

    if (window.speechSynthesis) {
      speechSynthesis.onvoiceschanged = () => {};
    }

    // When audio devices change — e.g. the Galaxy Buds connect or disconnect —
    // forget that we primed the mic, so the next listen re-engages whatever is
    // now the system default input (the Buds, if they just connected).
    if (navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener?.('devicechange', () => {
        this._micPrimed = false;
      });
    }
  }

  setLanguage(key) {
    if (!LANGUAGES[key]) return;
    this.lang = key;
    if (this.recognition) this.recognition.lang = LANGUAGES[key].code;
  }

  setPersona(key) {
    if (!VOICE_PERSONAS[key]) return;
    this.persona = key;
  }

  configureVoicevox({ mode, speakerId, localEndpoint, webEndpoint, webKey } = {}) {
    this.voicevox = {
      mode: mode || this.voicevox.mode || VOICEVOX_DEFAULTS.mode,
      speakerId: Number(speakerId) || this.voicevox.speakerId || VOICEVOX_DEFAULTS.speakerId,
      localEndpoint: localEndpoint || this.voicevox.localEndpoint || VOICEVOX_DEFAULTS.localEndpoint,
      webEndpoint: webEndpoint || this.voicevox.webEndpoint || VOICEVOX_DEFAULTS.webEndpoint,
      webKey: webKey ?? this.voicevox.webKey ?? VOICEVOX_DEFAULTS.webKey,
    };
  }

  startListening() {
    if (!this.recognition) return;
    speechSynthesis?.cancel();
    this.recognition.lang = LANGUAGES[this.lang].code;
    // Prime mic permission and engage the system's current default input device
    // (built-in, USB, or a paired Bluetooth headset) before starting. The Web
    // Speech API always captures from the OS default input — it has no way to
    // target a specific device — so a Bluetooth mic works as long as the tablet
    // has it selected as the default recording device. This getUserMedia call
    // just makes the permission prompt appear reliably and wakes that device up.
    this._ensureMicPermission()
      .then(() => {
        try {
          this.recognition.start();
        } catch {
          // already running — ignore
        }
      })
      .catch(() => {
        // permission denied / no device — already reported via onError
      });
  }

  // Request microphone access once so the permission prompt appears reliably on
  // tablets and the active input device is initialized. We release the stream
  // immediately because SpeechRecognition opens its own capture session.
  async _ensureMicPermission() {
    if (this._micPrimed) return;
    // If permission is already granted, DON'T re-open the mic here. On a
    // Bluetooth headset (e.g. Galaxy Buds 2) opening getUserMedia forces an
    // extra A2DP(music) <-> SCO(call) profile switch; doing it twice in a row
    // (prime, then SpeechRecognition) adds a stutter. When already granted, let
    // SpeechRecognition open the current default input device directly.
    try {
      const status = await navigator.permissions?.query({ name: 'microphone' });
      if (status?.state === 'granted') {
        this._micPrimed = true;
        return;
      }
    } catch {
      // Some browsers don't support querying 'microphone' — fall through.
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      // Old browser without mediaDevices — let SpeechRecognition prompt itself.
      this._micPrimed = true;
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      this._micPrimed = true;
    } catch (err) {
      const code =
        err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
          ? 'not-allowed'
          : err?.name === 'NotFoundError'
          ? 'no-device'
          : err?.name || 'mic-error';
      this.onError?.(code);
      throw err;
    }
  }

  stopListening() {
    this.recognition?.stop();
  }

  async speak(text, langKey = this.lang, personaKey = this.persona) {
    if (!text) return;
    speechSynthesis?.cancel();

    // VOICEVOX (Himari) only applies to Japanese; other languages use browser TTS.
    const vv = this.voicevox;
    if (langKey === 'ja' && vv.mode !== 'off') {
      try {
        if (vv.mode === 'web') {
          await this._speakVoicevoxWeb(text, vv.speakerId, vv.webEndpoint, vv.webKey);
        } else {
          await this._speakVoicevoxLocal(text, vv.speakerId, vv.localEndpoint);
        }
        return;
      } catch (err) {
        console.warn('VOICEVOX 사용 실패 — 브라우저 TTS로 대체:', err.message);
        // fall through to browser TTS so Newrosama always speaks
      }
    }

    this._speakBrowser(text, langKey, personaKey);
  }

  stopSpeaking() {
    speechSynthesis?.cancel();
  }

  // ---- private ---------------------------------------------------------------

  // Hosted VOICEVOX over HTTPS (api.tts.quest). Works on phones/tablets and
  // GitHub Pages without installing anything. Without a key the request may be
  // briefly queued, so we poll the status URL before playing.
  async _speakVoicevoxWeb(text, speakerId, endpoint, key) {
    const params = new URLSearchParams({ speaker: String(speakerId), text });
    if (key) params.set('key', key);

    const res = await fetch(`${endpoint}?${params.toString()}`);
    if (!res.ok) throw new Error(`tts.quest ${res.status}`);
    const data = await res.json();

    if (data.success === false || data.errorMessage) {
      throw new Error(data.errorMessage || 'tts.quest error');
    }

    const audioUrl = data.mp3StreamingUrl || data.wavDownloadUrl;
    if (!audioUrl) throw new Error('no audio url in response');

    // If a status URL is given, wait until the audio is actually ready.
    if (data.audioStatusUrl) {
      await this._waitForTtsQuest(data.audioStatusUrl, 15, 600);
    }

    return this._playUrl(audioUrl);
  }

  async _waitForTtsQuest(statusUrl, maxTries, delayMs) {
    for (let i = 0; i < maxTries; i++) {
      try {
        const r = await fetch(statusUrl);
        if (r.ok) {
          const s = await r.json();
          if (s.isAudioReady || s.isAudioError === false && s.isAudioReady !== false) return;
          if (s.isAudioError) throw new Error('tts.quest audio error');
        }
      } catch {
        // network blip — keep trying
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    // Timed out waiting; let the caller try playing anyway.
  }

  // VOICEVOX desktop app on localhost (two-step audio_query -> synthesis).
  async _speakVoicevoxLocal(text, speakerId, endpoint) {
    const queryRes = await fetch(
      `${endpoint}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
      { method: 'POST' }
    );
    if (!queryRes.ok) throw new Error(`audio_query ${queryRes.status}`);
    const query = await queryRes.json();

    query.speedScale = 1.05;
    query.pitchScale = 0.04;
    query.intonationScale = 1.1;
    query.volumeScale = 1.0;

    const synthRes = await fetch(`${endpoint}/synthesis?speaker=${speakerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
    });
    if (!synthRes.ok) throw new Error(`synthesis ${synthRes.status}`);

    const blob = await synthRes.blob();
    const url = URL.createObjectURL(blob);
    try {
      await this._playUrl(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  _playUrl(url) {
    return new Promise((resolve, reject) => {
      const audio = new Audio(url);
      this.onSpeakChange?.(true);
      audio.onended = () => { this.onSpeakChange?.(false); resolve(); };
      audio.onerror = (e) => { this.onSpeakChange?.(false); reject(e); };
      audio.play().catch((e) => { this.onSpeakChange?.(false); reject(e); });
    });
  }

  _speakBrowser(text, langKey, personaKey) {
    if (!window.speechSynthesis) return;
    const langCode = (LANGUAGES[langKey] || LANGUAGES.en).code;
    const persona = VOICE_PERSONAS[personaKey] || VOICE_PERSONAS.girl;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = langCode;
    utterance.rate = persona.rate;
    utterance.pitch = persona.pitch;

    const voice = pickBrowserVoice(langCode, personaKey);
    if (voice) utterance.voice = voice;

    utterance.onstart = () => this.onSpeakChange?.(true);
    utterance.onend = () => this.onSpeakChange?.(false);
    utterance.onerror = () => this.onSpeakChange?.(false);

    speechSynthesis.speak(utterance);
  }
}
