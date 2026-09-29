import { forwardRef, type SVGProps } from "react";

/** Bestie's raster companion mark, framed as an icon so navigation rows and search can size it. */
export const BestieMarkArtwork = forwardRef<
  SVGSVGElement,
  SVGProps<SVGSVGElement> & {
    size?: number | string;
    // Phosphor-only options arrive from shared icon call sites; raster art has no weights.
    weight?: string;
    mirrored?: boolean;
  }
>(function BestieMarkArtwork(
  { size = "1em", weight: _weight, mirrored: _mirrored, ...props },
  ref,
) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: the public gateway supplies accessibility semantics.
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 256 256"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <image
        href="/bestie.png"
        width="256"
        height="256"
        preserveAspectRatio="xMidYMid meet"
      />
    </svg>
  );
});
