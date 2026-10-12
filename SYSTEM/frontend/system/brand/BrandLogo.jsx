import React, { useEffect, useState } from "react";

import { useBranding } from "./BrandContext.jsx";
import { DEFAULT_BRANDING, DEFAULT_BRAND_LOGO_URL } from "./brandModel.js";

export default function BrandLogo({
  branding: brandingOverride,
  className = "",
  decorative = false,
  alt,
  ...imageProps
}) {
  const { branding: contextualBranding } = useBranding();
  const branding = brandingOverride || contextualBranding || DEFAULT_BRANDING;
  const configuredUrl = branding.logo?.url || DEFAULT_BRAND_LOGO_URL;
  const [renderedLogo, setRenderedLogo] = useState(() => ({
    url: configuredUrl,
    fallback: false,
  }));

  useEffect(() => setRenderedLogo({ url: configuredUrl, fallback: false }), [configuredUrl]);

  const dimensions = renderedLogo.fallback ? DEFAULT_BRANDING.logo : branding.logo;

  return (
    <img
      {...imageProps}
      className={className}
      src={renderedLogo.url}
      width={dimensions?.width || DEFAULT_BRANDING.logo.width}
      height={dimensions?.height || DEFAULT_BRANDING.logo.height}
      alt={decorative ? "" : alt ?? branding.logoAltText ?? `${branding.displayName} Logo`}
      onError={(event) => {
        imageProps.onError?.(event);
        if (!renderedLogo.fallback) {
          setRenderedLogo({ url: DEFAULT_BRAND_LOGO_URL, fallback: true });
        }
      }}
    />
  );
}
