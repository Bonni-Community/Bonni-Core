import React from "react";

import { useBranding } from "./BrandContext.jsx";
import { DEFAULT_BRANDING } from "./brandModel.js";

export default function BrandName({ as: Element = "span", branding: brandingOverride, children, ...props }) {
  const { branding: contextualBranding } = useBranding();
  const branding = brandingOverride || contextualBranding || DEFAULT_BRANDING;
  return <Element {...props}>{children || branding.displayName || DEFAULT_BRANDING.displayName}</Element>;
}
