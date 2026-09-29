import { memo } from "react";
import { QrCode } from "../lib/qr-code";

type QrCodeSvgProps = {
  value: string;
  size?: number;
  title?: string;
  className?: string;
};

function buildQrPathData(qrCode: ReturnType<typeof QrCode.encodeText>, marginSize: number): string {
  const commands: string[] = [];
  for (let y = 0; y < qrCode.size; y += 1) {
    let runStart = -1;
    for (let x = 0; x <= qrCode.size; x += 1) {
      const isDark = x < qrCode.size && qrCode.getModule(x, y);
      if (isDark) {
        if (runStart === -1) runStart = x;
        continue;
      }
      if (runStart === -1) continue;
      // SVG path commands are machine syntax, not visible user-facing copy.
      // eslint-disable-next-line local-i18n/no-hardcoded-ui-strings
      commands.push(`M${runStart + marginSize} ${y + marginSize}h${x - runStart}v1H${runStart + marginSize}z`);
      runStart = -1;
    }
  }
  return commands.join("");
}

export const QrCodeSvg = memo(function QrCodeSvg({
  value,
  size = 220,
  title,
  className,
}: QrCodeSvgProps) {
  const qrCode = QrCode.encodeText(value, QrCode.Ecc.MEDIUM);
  const marginSize = 4;
  const viewBoxSize = qrCode.size + marginSize * 2;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role="img"
      aria-label={title}
      className={className}
    >
      {title ? <title>{title}</title> : null}
      <rect width={viewBoxSize} height={viewBoxSize} fill="#fff" />
      <path d={buildQrPathData(qrCode, marginSize)} fill="#111" />
    </svg>
  );
});
