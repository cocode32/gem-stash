/**
 * Codecs that the `flac` binary can ingest directly without an ffmpeg decode step.
 * `flac` reads PCM-bearing containers (WAV/AIFF), raw PCM, and existing FLAC.
 * Anything else (ALAC, AAC, MP3, etc.) must be decoded to PCM by ffmpeg first.
 */
export const FLAC_NATIVE_CODECS = new Set(["pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_s16be", "pcm_s24be", "pcm_u8", "flac"]);

export const LOSSLESS_CODECS = new Set(["lpcm", "flac", "alac", "aiff", ...FLAC_NATIVE_CODECS]);

export const LOSSY_CODECS = new Set(["aac", "mp3", "ogg", "opus", "vorbis", "wma", "aach", "aac "]);
