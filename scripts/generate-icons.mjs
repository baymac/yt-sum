// Generate the extension icons (16/48/128) so the extension loads without
// missing-resource warnings. A rounded purple gradient tile with a white play
// triangle — matches the button's #667eea→#764ba2 gradient.

import { writeFile, mkdir } from "node:fs/promises";
import { PNG } from "pngjs";

const C1 = [0x66, 0x7e, 0xea]; // #667eea
const C2 = [0x76, 0x4a, 0xa2]; // #764ba2

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

function pointInTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
	const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
	const s = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / d;
	const u = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / d;
	return s >= 0 && u >= 0 && s + u <= 1;
}

function makeIcon(size) {
	const png = new PNG({ width: size, height: size });
	const radius = size * 0.22;

	// Right-pointing play triangle, centered, slightly nudged right for balance.
	const cx = size / 2;
	const cy = size / 2;
	const tw = size * 0.30;
	const th = size * 0.34;
	const A = [cx - tw * 0.45 + size * 0.03, cy - th / 2];
	const B = [cx - tw * 0.45 + size * 0.03, cy + th / 2];
	const C = [cx + tw * 0.55 + size * 0.03, cy];

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const idx = (size * y + x) << 2;

			// Rounded-corner alpha mask.
			let alpha = 255;
			const corners = [
				[radius, radius],
				[size - radius, radius],
				[radius, size - radius],
				[size - radius, size - radius],
			];
			const inCornerBox =
				(x < radius || x > size - radius) && (y < radius || y > size - radius);
			if (inCornerBox) {
				const nearest = corners.reduce(
					(best, [ccx, ccy]) => {
						const dd = Math.hypot(x + 0.5 - ccx, y + 0.5 - ccy);
						return dd < best.dd ? { dd, ccx, ccy } : best;
					},
					{ dd: Infinity },
				);
				if (nearest.dd > radius) alpha = 0;
				else if (nearest.dd > radius - 1) alpha = Math.round(255 * (radius - nearest.dd));
			}

			// Diagonal gradient background.
			const t = (x + y) / (2 * size);
			let r = lerp(C1[0], C2[0], t);
			let g = lerp(C1[1], C2[1], t);
			let b = lerp(C1[2], C2[2], t);

			// White play triangle.
			if (pointInTriangle(x + 0.5, y + 0.5, A, B, C)) {
				r = g = b = 255;
			}

			png.data[idx] = r;
			png.data[idx + 1] = g;
			png.data[idx + 2] = b;
			png.data[idx + 3] = alpha;
		}
	}
	return PNG.sync.write(png);
}

await mkdir("icons", { recursive: true });
for (const size of [16, 48, 128]) {
	await writeFile(`icons/icon${size}.png`, makeIcon(size));
	console.log(`wrote icons/icon${size}.png`);
}
