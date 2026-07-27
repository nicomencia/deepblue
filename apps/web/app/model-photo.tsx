/**
 * The little photo that makes a row recognisable without reading it.
 *
 * Deliberately dumb: no photo renders nothing at all rather than a placeholder
 * box, because an empty frame reads as "broken" while an absent one reads as
 * "this list is about text". Sizing is fixed and the image is cropped to it,
 * so rows stay the same height whatever aspect ratio research came back with.
 */
export function ModelPhoto({
  src,
  alt,
  width = 104,
  height = 68,
}: {
  src?: string;
  alt: string;
  width?: number;
  height?: number;
}) {
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- external research/CDN URLs, unknown domains
    <img
      src={src}
      alt={alt}
      loading="lazy"
      width={width}
      height={height}
      style={{
        width,
        height,
        objectFit: "cover",
        borderRadius: 6,
        border: "1px solid var(--border)",
        flexShrink: 0,
        background: "var(--card)",
      }}
    />
  );
}
