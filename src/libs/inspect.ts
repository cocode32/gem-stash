import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type StreamInfo = {
	codec: string;
	channels: number;
	sampleRate: number;
	bitsPerChannel: number | null;
	bitRate: number | null;
	durationSeconds: number | null;
	inspector: "ffprobe";
};

export type Tags = {
	artist?: string;
	albumArtist?: string;
	album?: string;
	title?: string;
	track?: string;
	disc?: string;
	date?: string;
	genre?: string;
	compilation?: string;
};

export type InspectResult = {
	stream: StreamInfo;
	tags: Tags;
};

export async function inspect(path: string): Promise<InspectResult> {
	const stream = await ffprobeStream(path);
	const tags = await ffprobeTags(path);
	return { stream, tags };
}

async function ffprobeStream(path: string): Promise<StreamInfo> {
	const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_streams", "-of", "json", path], {
		maxBuffer: 1024 * 1024,
	});
	const data = JSON.parse(stdout);
	const s = data.streams?.[0];
	if (!s) throw new Error("ffprobe: no audio stream");
	const bits = s.bits_per_sample || s.bits_per_raw_sample || null;
	return {
		codec: String(s.codec_name).toLowerCase(),
		channels: Number(s.channels),
		sampleRate: Number(s.sample_rate),
		bitsPerChannel: bits ? Number(bits) : null,
		bitRate: s.bit_rate ? Number(s.bit_rate) : null,
		durationSeconds: s.duration ? Number(s.duration) : null,
		inspector: "ffprobe",
	};
}

async function ffprobeTags(path: string): Promise<Tags> {
	try {
		const { stdout } = await exec("ffprobe", ["-v", "error", "-show_format", "-of", "json", path], { maxBuffer: 1024 * 1024 });
		const data = JSON.parse(stdout);
		const raw = (data.format?.tags ?? {}) as Record<string, unknown>;
		const norm: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw)) norm[k.toLowerCase()] = String(v);
		return {
			artist: norm.artist,
			albumArtist: norm.album_artist ?? norm.albumartist,
			album: norm.album,
			title: norm.title,
			track: norm.track,
			disc: norm.disc,
			date: norm.date,
			genre: norm.genre,
			compilation: norm.compilation,
		};
	} catch {
		return {};
	}
}
