function revision(value) {
  return String(value?.revision ?? value ?? "");
}

function hasDirtyText(state) {
  return Boolean(state.dirtyFields.displayName || state.dirtyFields.logoAltText);
}

export function createBrandingEditState(branding) {
  return {
    draft: {
      displayName: branding.displayName,
      logoAltText: branding.logoAltText,
    },
    dirtyFields: {
      displayName: false,
      logoAltText: false,
    },
    textBaseRevision: null,
    file: null,
    fileBaseRevision: null,
    textConflict: false,
    fileConflict: false,
  };
}

export function changeBrandingText(state, field, value, currentRevision) {
  if (!Object.hasOwn(state.dirtyFields, field)) return state;
  return {
    ...state,
    draft: { ...state.draft, [field]: value },
    dirtyFields: { ...state.dirtyFields, [field]: true },
    textBaseRevision: hasDirtyText(state)
      ? state.textBaseRevision
      : revision(currentRevision),
  };
}

export function selectBrandingEditFile(state, file, currentRevision) {
  return {
    ...state,
    file: file || null,
    fileBaseRevision: file ? revision(currentRevision) : null,
    fileConflict: false,
  };
}

export function observeBrandingRevision(state, branding) {
  const nextRevision = revision(branding);
  const dirtyText = hasDirtyText(state);
  return {
    ...state,
    draft: {
      displayName: state.dirtyFields.displayName
        ? state.draft.displayName
        : branding.displayName,
      logoAltText: state.dirtyFields.logoAltText
        ? state.draft.logoAltText
        : branding.logoAltText,
    },
    textConflict: Boolean(
      dirtyText
      && state.textBaseRevision !== null
      && state.textBaseRevision !== nextRevision
    ),
    fileConflict: Boolean(
      state.file
      && state.fileBaseRevision !== null
      && state.fileBaseRevision !== nextRevision
    ),
  };
}

export function applyOwnBrandingLogoSuccess(state, branding) {
  const dirtyText = hasDirtyText(state);
  const nextRevision = revision(branding);
  return {
    ...state,
    draft: {
      displayName: state.dirtyFields.displayName
        ? state.draft.displayName
        : branding.displayName,
      logoAltText: state.dirtyFields.logoAltText
        ? state.draft.logoAltText
        : branding.logoAltText,
    },
    textBaseRevision: dirtyText ? nextRevision : null,
    file: null,
    fileBaseRevision: null,
    textConflict: false,
    fileConflict: false,
  };
}

export function applyOwnBrandingMetadataSuccess(state, branding) {
  const nextRevision = revision(branding);
  return {
    ...state,
    draft: {
      displayName: branding.displayName,
      logoAltText: branding.logoAltText,
    },
    dirtyFields: {
      displayName: false,
      logoAltText: false,
    },
    textBaseRevision: null,
    fileBaseRevision: state.file ? nextRevision : null,
    textConflict: false,
    fileConflict: false,
  };
}

export function discardLocalBrandingEdits(_state, branding) {
  return createBrandingEditState(branding);
}

export function brandingEditHasDirtyText(state) {
  return hasDirtyText(state);
}

export function brandingEditConflictState(state, currentRevision) {
  if (currentRevision === undefined) {
    return { text: Boolean(state.textConflict), file: Boolean(state.fileConflict) };
  }
  const nextRevision = revision(currentRevision);
  return {
    text: Boolean(
      state.textConflict
      || (hasDirtyText(state)
        && state.textBaseRevision !== null
        && state.textBaseRevision !== nextRevision)
    ),
    file: Boolean(
      state.fileConflict
      || (state.file
        && state.fileBaseRevision !== null
        && state.fileBaseRevision !== nextRevision)
    ),
  };
}

export function brandingEditHasConflict(state, currentRevision) {
  const conflict = brandingEditConflictState(state, currentRevision);
  return conflict.text || conflict.file;
}

export function brandingTextExpectedRevision(state, currentRevision) {
  return state.textBaseRevision ?? revision(currentRevision);
}

export function brandingFileExpectedRevision(state) {
  return state.fileBaseRevision;
}
