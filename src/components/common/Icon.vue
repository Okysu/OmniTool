<script setup lang="ts">
/**
 * Icon resolver.
 *
 * Plugin manifests name icons as strings, so we need a runtime lookup rather
 * than static imports at the call site. Lucide is imported by name into a small
 * registry so the bundle only carries the glyphs we actually ship; unknown names
 * (including anything a third-party plugin invents) fall back to a neutral one.
 */
import { computed } from 'vue'
import {
  AlertTriangle, Aperture, Archive, Circle, ArrowDown, ArrowDownUp, ArrowUp, Ban, Barcode, Blend, Brush, Check, ChevronDown,
  ChevronRight, CircleAlert, CircleCheck, Combine, Copy, Cpu, Crop, Droplet, Download, Eraser,
  ExternalLink, Eye, FileArchive, FileCode, FileJson, FileText, FileType, Film, Filter, FlipHorizontal, FlipVertical,
  FolderOpen, Gauge, GraduationCap, Grid3x3, GripVertical, HardDrive, Hash, Image, ImageDown, ImagePlus, Info, KeyRound,
  Layers, LayoutGrid, ListOrdered, ListTodo, Loader2, Lock, LockOpen, Maximize2, Merge, Minimize2,
  Monitor, Moon, Music, Package, PanelLeft, PanelLeftClose, Pause, PenLine, Pin, PinOff, Play, Plus, Puzzle,
  QrCode, RefreshCw, Ratio, RotateCw, Rss, Scaling, ScanText, Scissors, Search, Settings, Shapes, ShieldAlert,
  ShieldCheck, SlidersHorizontal, Sparkles, SplitSquareHorizontal, Stamp, Sun, Table, Terminal, Timer,
  Trash2, Type, Upload, Video, Volume2, VolumeX, Wand2, Waves, Workflow, Wrench, X, ZoomIn,
} from '@lucide/vue'

const props = withDefaults(defineProps<{ name?: string; size?: number; strokeWidth?: number }>(), {
  name: 'package',
  size: 16,
  strokeWidth: 2,
})

const REGISTRY: Record<string, unknown> = {
  'alert-triangle': AlertTriangle, aperture: Aperture, archive: Archive, 'arrow-down': ArrowDown, 'arrow-down-up': ArrowDownUp, 'arrow-up': ArrowUp,
  ban: Ban, barcode: Barcode, blend: Blend, brush: Brush, check: Check, 'chevron-down': ChevronDown,
  'chevron-right': ChevronRight, 'circle-alert': CircleAlert, 'circle-check': CircleCheck,
  combine: Combine, copy: Copy, cpu: Cpu, crop: Crop, droplet: Droplet, download: Download,
  eraser: Eraser, 'external-link': ExternalLink, eye: Eye, 'file-archive': FileArchive,
  'file-code': FileCode, 'file-json': FileJson, 'file-text': FileText, 'file-type': FileType,
  film: Film, filter: Filter, flip: FlipHorizontal, 'flip-vertical': FlipVertical, 'folder-open': FolderOpen, gauge: Gauge,
  grid: Grid3x3, 'grip-vertical': GripVertical, 'graduation-cap': GraduationCap, 'hard-drive': HardDrive, hash: Hash, image: Image,
  'image-down': ImageDown, 'image-plus': ImagePlus, info: Info, key: KeyRound, layers: Layers,
  'layout-grid': LayoutGrid, 'list-ordered': ListOrdered, 'list-todo': ListTodo, loader: Loader2,
  lock: Lock, 'lock-open': LockOpen, maximize: Maximize2, merge: Merge, minimize: Minimize2,
  monitor: Monitor, moon: Moon, music: Music, package: Package, 'panel-left': PanelLeft,
  'panel-left-close': PanelLeftClose, pause: Pause, 'pen-line': PenLine, pin: Pin, 'pin-off': PinOff, play: Play,
  plus: Plus, puzzle: Puzzle, 'qr-code': QrCode, refresh: RefreshCw, ratio: Ratio, 'rotate-cw': RotateCw, rss: Rss,
  scaling: Scaling, 'scan-text': ScanText, scissors: Scissors, search: Search, settings: Settings,
  shapes: Shapes, 'shield-alert': ShieldAlert, 'shield-check': ShieldCheck,
  sliders: SlidersHorizontal, sparkles: Sparkles, split: SplitSquareHorizontal, stamp: Stamp,
  sun: Sun, table: Table, terminal: Terminal, timer: Timer, trash: Trash2, type: Type, upload: Upload, workflow: Workflow, wrench: Wrench, circle: Circle,
  video: Video, volume: Volume2, 'volume-off': VolumeX, wand: Wand2, waves: Waves, x: X,
  'zoom-in': ZoomIn,
}

const component = computed(() => REGISTRY[props.name] ?? REGISTRY.package)
</script>

<template>
  <component :is="component" :size="size" :stroke-width="strokeWidth" aria-hidden="true" />
</template>
