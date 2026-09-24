import React, { memo } from 'react';
import { Handle, Position, NodeResizer } from '@xyflow/react';

// Every entity the map can hold. `fields` drives the inspector form; `make`
// builds default data when the entity is dropped from the palette.
export const KINDS = {
  host: {
    label: 'Hôte', color: '#6fb6c9',
    icon: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8
