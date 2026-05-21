export interface RawCaption {
	startSec: number;
	endSec: number;
	text: string;
	recordingSegment?: number;
}

export interface RefineOptions {
	maxChars: number;
	maxDurSec: number;
	gapForParagraphSec: number;
}

const STOPWORDS_AT_END = new Set([
	"the",
	"a",
	"an",
	"to",
	"of",
	"in",
	"on",
	"at",
	"for",
	"with",
	"by",
	"from",
	"as",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"am",
	"and",
	"or",
	"but",
	"so",
	"if",
	"that",
	"this",
	"these",
	"those",
	"you",
	"your",
	"we",
	"our",
	"i",
	"it",
	"its",
	"my",
	"me",
	"they",
	"their",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"can",
	"could",
	"will",
	"would",
	"should",
	"may",
	"might",
	"must",
	"into",
	"about",
	"there",
	"here",
	"when",
	"while",
	"like",
	"because",
	"than",
]);

function isArtifact(text: string): boolean {
	const t = text.trim();
	return /^\[[^\]]+\]\.?$/i.test(t);
}

function cleanWord(w: string): string {
	return w.toLowerCase().replace(/[.,!?;:]+$/, "");
}

function splitByWords(text: string, maxChars: number): string[] {
	const words = text.split(/\s+/).filter((w) => w.length > 0);
	const pieces: string[] = [];
	let cur: string[] = [];
	let curLen = 0;

	const flush = () => {
		if (cur.length === 0) return;
		const trailing: string[] = [];
		while (cur.length > 1) {
			const last = cur[cur.length - 1]!;
			if (STOPWORDS_AT_END.has(cleanWord(last))) {
				trailing.unshift(cur.pop()!);
			} else {
				break;
			}
		}
		pieces.push(cur.join(" "));
		cur = trailing;
		curLen = trailing.reduce((s, w) => s + w.length, 0) + Math.max(0, trailing.length - 1);
	};

	for (const w of words) {
		const addLen = w.length + (cur.length > 0 ? 1 : 0);
		if (curLen + addLen > maxChars && cur.length > 0) {
			flush();
		}
		cur.push(w);
		curLen += addLen;
	}
	flush();
	return pieces.filter((p) => p.length > 0);
}

function splitText(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];

	const sentences = text.split(/(?<=[.!?])\s+/).filter((p) => p.length > 0);
	if (sentences.length > 1) {
		return sentences.flatMap((p) => splitText(p, maxChars));
	}

	const clauses = text.split(/(?<=[,;:])\s+/).filter((p) => p.length > 0);
	if (clauses.length > 1) {
		const combined: string[] = [];
		let buf = "";
		for (const c of clauses) {
			if (!buf) {
				buf = c;
			} else if (buf.length + 1 + c.length <= maxChars) {
				buf = `${buf} ${c}`;
			} else {
				combined.push(buf);
				buf = c;
			}
		}
		if (buf) combined.push(buf);
		return combined.flatMap((p) => (p.length <= maxChars ? [p] : splitByWords(p, maxChars)));
	}

	return splitByWords(text, maxChars);
}

export function refineCaptions(raw: RawCaption[], opts: RefineOptions): RawCaption[] {
	const filtered = raw.filter((c) => !isArtifact(c.text) && c.text.trim().length > 0);
	if (filtered.length === 0) return [];

	const paragraphs: RawCaption[][] = [[]];
	for (const c of filtered) {
		const lastPara = paragraphs[paragraphs.length - 1]!;
		if (lastPara.length === 0) {
			lastPara.push(c);
			continue;
		}
		const lastCap = lastPara[lastPara.length - 1]!;
		const gap = c.startSec - lastCap.endSec;
		const sameRec =
			c.recordingSegment === undefined ||
			lastCap.recordingSegment === undefined ||
			c.recordingSegment === lastCap.recordingSegment;
		if (gap > opts.gapForParagraphSec || !sameRec) {
			paragraphs.push([c]);
		} else {
			lastPara.push(c);
		}
	}

	const out: RawCaption[] = [];
	for (const para of paragraphs) {
		if (para.length === 0) continue;

		const fullText = para
			.map((p) => p.text.trim())
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		const startSec = para[0]!.startSec;
		const endSec = para[para.length - 1]!.endSec;
		const totalDur = endSec - startSec;

		const chunks = splitText(fullText, opts.maxChars);

		// Cap each chunk's duration by re-distributing per char-count, then if any chunk
		// still > maxDurSec we proportionally shrink and push the overflow into ambient
		// (won't happen often since chunks are <= maxChars).
		const totalChars = chunks.reduce((s, c) => s + c.length, 0);
		let charOffset = 0;
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i]!;
			const isLast = i === chunks.length - 1;
			const cStart = startSec + (charOffset / totalChars) * totalDur;
			const cEnd = isLast
				? endSec
				: startSec + ((charOffset + chunk.length) / totalChars) * totalDur;
			out.push({ startSec: cStart, endSec: cEnd, text: chunk });
			charOffset += chunk.length;
		}
	}

	// Cap caption duration: if a chunk's duration > maxDurSec, split it
	// (rare since we cap by chars, but guards against very slow speech).
	const final: RawCaption[] = [];
	for (const c of out) {
		const dur = c.endSec - c.startSec;
		if (dur <= opts.maxDurSec) {
			final.push(c);
			continue;
		}
		const parts = Math.ceil(dur / opts.maxDurSec);
		const sub = splitByWords(c.text, Math.ceil(c.text.length / parts));
		const subChars = sub.reduce((s, p) => s + p.length, 0);
		let off = 0;
		for (let i = 0; i < sub.length; i++) {
			const s = sub[i]!;
			const isLast = i === sub.length - 1;
			const ps = c.startSec + (off / subChars) * dur;
			const pe = isLast ? c.endSec : c.startSec + ((off + s.length) / subChars) * dur;
			final.push({ startSec: ps, endSec: pe, text: s });
			off += s.length;
		}
	}

	return final;
}
