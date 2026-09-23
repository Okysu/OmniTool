/* eslint-disable */
/**
 * Built-in plugin: audio & video toolbox, on the host's FFmpeg (WASM) build.
 *
 * Scope note: the reference toolboxes list ~80 routes like "MOV to MP4",
 * "MKV to MP3", "WEBM to MOV". Those are one transcode with a different output
 * container, so they live here as a format parameter rather than as 80 tools.
 * The operations that are genuinely distinct - trimming, cropping, speed,
 * subtitles, concatenation - each get their own tool. See
 * docs/design/03-tool-matrix.md for the full mapping.
 *
 * Editing tools draw a `media` panel instead of a form: the user scrubs the real
 * file, drags a crop box, and hears fades before exporting. The panel previews
 * with browser primitives; every export is ffmpeg, and each filter chain below
 * is ordered to match what the preview shows.
 *
 * Everything runs locally; no frame ever leaves the machine.
 */
definePlugin({
  id: 'omnitool.media',
  name: '音视频工具箱',
  version: '2.0.0',
  author: 'OmniTool',
  description: '转码、压缩、裁剪、画面与音频可视化编辑、GIF、抽帧、拼接——基于本地 FFmpeg。',
  icon: 'video',
  capabilities: ['fs', 'ui', 'ffmpeg'],
  deps: [
    // Only for tools that draw text into video (watermarks, burned-in subtitles).
    { id: 'cjk-font', url: '/vendor/fonts/fonts.js', global: 'OMNITOOL_FONTS', lazy: true, assets: { 'NotoSansSC-Regular.ttf': { url: '/vendor/fonts/NotoSansSC-Regular.ttf' } } },
    // Spectrograms: ffmpeg only decodes, the FFT runs here.
    { id: 'fft', url: '/vendor/fft.js', global: 'FFT', lazy: true },
  ],

  tools: [
    {
      id: 'convert-video',
      name: '视频转码',
      category: 'media',
      icon: 'film',
      description: '在 MP4 / MKV / MOV / WebM / AVI 之间互转，可调编码器、质量与分辨率。',
      accept: ['video/*', '.mkv', '.mov', '.avi', '.webm', '.flv', '.ts', '.m4v'],
      multiple: true,
      keywords: ['convert', 'transcode', 'mp4', 'mkv', 'mov', 'webm', 'avi', '转码', '视频转换'],
      params: [
        {
          key: 'container', type: 'select', label: '输出容器', default: 'mp4',
          options: [
            { value: 'mp4', label: 'MP4（兼容性最好）' }, { value: 'mkv', label: 'MKV' },
            { value: 'mov', label: 'MOV' }, { value: 'webm', label: 'WebM（VP9）' }, { value: 'avi', label: 'AVI' },
          ],
        },
        {
          key: 'codec', type: 'select', label: '视频编码', default: 'libx264',
          options: [
            { value: 'libx264', label: 'H.264（通用）' }, { value: 'libx265', label: 'H.265 / HEVC（更小，更慢）' },
            { value: 'libvpx-vp9', label: 'VP9（WebM）' }, { value: 'copy', label: '不重新编码（仅换容器）' },
          ],
        },
        { key: 'crf', type: 'slider', label: '质量 (CRF)', min: 14, max: 40, default: 23, hint: '数值越小画质越好、体积越大。23 是常用默认值。', when: { key: 'codec', equals: ['libx264', 'libx265', 'libvpx-vp9'] } },
        {
          key: 'preset', type: 'select', label: '编码速度', default: 'medium',
          options: [
            { value: 'ultrafast', label: '极快（体积大）' }, { value: 'veryfast', label: '很快' },
            { value: 'medium', label: '中等' }, { value: 'slow', label: '慢（体积小）' },
          ],
          when: { key: 'codec', equals: ['libx264', 'libx265'] },
        },
        {
          key: 'resolution', type: 'select', label: '分辨率', default: 'keep',
          options: [
            { value: 'keep', label: '保持原分辨率' }, { value: '3840', label: '4K (2160p)' },
            { value: '1920', label: '1080p' }, { value: '1280', label: '720p' },
            { value: '854', label: '480p' }, { value: '640', label: '360p' },
          ],
        },
        { key: 'fps', type: 'number', label: '帧率', default: 0, min: 0, max: 120, suffix: 'fps', hint: '0 表示保持原帧率。' },
        {
          key: 'audio', type: 'select', label: '音频处理', default: 'aac',
          options: [
            { value: 'aac', label: 'AAC 128k' }, { value: 'copy', label: '直接复制' },
            { value: 'libopus', label: 'Opus（WebM）' }, { value: 'none', label: '移除音轨' },
          ],
        },
      ],

      async run(ctx) {
        const p = ctx.params
        const outputs = []

        await eachInput(ctx, async (input, index) => {
          const args = ['-i', `$in${0}`]

          if (p.codec === 'copy') {
            args.push('-c:v', 'copy')
          } else {
            args.push('-c:v', String(p.codec), '-crf', String(p.crf))
            if (p.codec === 'libx264' || p.codec === 'libx265') args.push('-preset', String(p.preset))
            if (p.codec === 'libx265') args.push('-tag:v', 'hvc1')
          }

          const filters = []
          if (p.codec !== 'copy' && p.resolution !== 'keep') filters.push(`scale=${p.resolution}:-2:flags=lanczos`)
          if (filters.length) args.push('-vf', filters.join(','))
          if (Number(p.fps) > 0) args.push('-r', String(Number(p.fps)))

          if (p.audio === 'none') args.push('-an')
          else if (p.audio === 'copy') args.push('-c:a', 'copy')
          else args.push('-c:a', String(p.audio), '-b:a', '128k')

          if (p.container === 'mp4' || p.container === 'mov') args.push('-movflags', '+faststart')
          args.push('-y', `$out${0}`)

          const name = `${baseName(input.name)}.${p.container}`
          const result = await runMediaFfmpeg({
            args, inputs: [input.id], outputs: [name],
            label: `转码 ${input.name}（${index + 1}/${ctx.inputs.length}）`,
          })
          outputs.push(result.files[0].id)
        })

        return { outputs, summary: `已转码 ${outputs.length} 个视频为 ${String(p.container).toUpperCase()}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'compress-video',
      name: '视频压缩',
      category: 'media',
      icon: 'gauge',
      description: '按画质等级或目标体积压缩，压缩前即可看到预计体积与码率。',
      accept: ['video/*', '.mkv', '.mov', '.avi', '.webm'],
      multiple: true,
      keywords: ['compress', 'shrink', '压缩', '瘦身', '体积'],

      async setup(ui) {
        if (!requireInputs(ui, 1, '先拖入要压缩的视频', '可以一次拖入多个，预计体积会按第一个视频的时长估算。')) return

        const LEVELS = [
          { value: '24', label: '高画质', ratio: 0.7 },
          { value: '28', label: '均衡', ratio: 0.45 },
          { value: '32', label: '小体积', ratio: 0.25 },
          { value: '36', label: '极小', ratio: 0.15 },
        ]
        const total = ui.inputs.reduce((sum, input) => sum + input.size, 0)

        livePanel(ui, COMPRESS_DEFAULTS, (state) => {
          const [duration = 0] = state.meta
          const facts = [
            { label: '文件', value: ui.inputs.length > 1 ? `${ui.inputs.length} 个，共 ${bytesLabel(total)}` : bytesLabel(total) },
          ]
          if (duration) facts.push({ label: '时长', value: formatSpan(duration) })
          const alerts = []

          if (state.mode === 'size') {
            if (duration) {
              const videoKbps = targetVideoKbps(Number(state.targetMB), duration)
              facts.push({ label: '视频码率', value: `${videoKbps} kbps（音频 128 kbps）` })
              if (videoKbps <= 300) alerts.push({ type: 'alert', tone: 'warning', title: '码率很低', text: '目标体积相对时长太小，画面会明显模糊。可以提高目标体积或开启 1080p 限制。' })
            }
            if (ui.inputs.length === 1 && Number(state.targetMB) * 1024 * 1024 >= ui.inputs[0].size) {
              alerts.push({ type: 'alert', tone: 'info', title: '目标不小于原文件', text: '原文件已经小于目标体积，压缩后反而可能变大。' })
            }
          } else {
            const level = LEVELS.find((l) => l.value === state.level) ?? LEVELS[1]
            facts.push({ label: '预计输出', value: `约 ${bytesLabel(total * level.ratio)}（经验值，取决于画面复杂度）` })
          }

          return {
            runLabel: '开始压缩',
            nodes: [
              { type: 'media', fileId: ui.inputs[0].id, meta: 'meta', height: 240 },
              { type: 'segmented', bind: 'mode', label: '压缩方式', options: [{ value: 'quality', label: '按画质等级' }, { value: 'size', label: '按目标体积' }] },
              { type: 'segmented', bind: 'level', label: '画质等级', when: { key: 'mode', equals: 'quality' }, options: LEVELS.map((l) => ({ value: l.value, label: l.label })) },
              { type: 'input', bind: 'targetMB', label: '目标体积', inputType: 'number', min: 1, suffix: 'MB', when: { key: 'mode', equals: 'size' }, hint: '两遍编码，尽量贴近目标。' },
              { type: 'switch', bind: 'downscale', label: '同时限制到 1080p' },
              { type: 'facts', rows: facts },
              ...alerts,
            ],
          }
        })
      },

      async run(ctx) {
        ctx.params = withDefaults(ctx.params, COMPRESS_DEFAULTS)
        const p = ctx.params
        const outputs = []
        let before = 0
        let after = 0

        await eachInput(ctx, async (input, index) => {
          const name = `${baseName(input.name)}-compressed.mp4`
          const scale = p.downscale ? ["-vf", "scale='min(1920,iw)':-2:flags=lanczos"] : []
          const label = `压缩 ${input.name}（${index + 1}/${ctx.inputs.length}）`
          let result

          if (p.mode === 'size') {
            const probe = await host.ffmpeg.probe(input.id)
            const duration = probe.durationSeconds
            if (!duration || duration <= 0) throw new Error(`${input.name}：无法读取时长，请改用「按画质等级」`)
            const videoKbps = targetVideoKbps(Number(p.targetMB), duration)

            // Two passes so the encoder can actually hit the target.
            const pass1 = await runMediaFfmpeg({
              args: ['-i', '$in0', ...scale, '-c:v', 'libx264', '-b:v', `${videoKbps}k`, '-pass', '1', '-an', '-f', 'mp4', '-y', '$out0'],
              inputs: [input.id], outputs: ['pass1.mp4'], label: `${label} · 第 1 遍`,
            })
            // The first pass exists only to build the rate-control stats file.
            await host.fs.remove(pass1.files[0].id).catch(() => {})
            result = await runMediaFfmpeg({
              args: [
                '-i', '$in0', ...scale, '-c:v', 'libx264', '-b:v', `${videoKbps}k`, '-pass', '2',
                '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', '$out0',
              ],
              inputs: [input.id], outputs: [name], label: `${label} · 第 2 遍`,
            })
          } else {
            result = await runMediaFfmpeg({
              args: [
                '-i', '$in0', ...scale, '-c:v', 'libx264', '-crf', String(p.level), '-preset', 'medium',
                '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', '$out0',
              ],
              inputs: [input.id], outputs: [name], label,
            })
          }

          before += input.size
          after += result.files[0].size
          outputs.push(result.files[0].id)
        })

        return { outputs, summary: `${outputs.length} 个视频：${bytesLabel(before)} → ${bytesLabel(after)}（${deltaLabel(before, after)}）` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'trim',
      name: '裁剪片段',
      category: 'media',
      icon: 'scissors',
      description: '在时间轴上拖动选区截取音视频片段，可预览选区后再导出。',
      accept: ['video/*', 'audio/*', '.mkv', '.mov', '.avi', '.webm', '.m4a', '.flac'],
      // One file at a time: a visual range belongs to one piece of media.
      multiple: false,
      keywords: ['trim', 'cut', 'clip', '裁剪', '剪辑', '截取', '片段'],

      async setup(ui) {
        if (!requireInputs(ui, 1, '先拖入一个音视频文件', '随后这里会出现可拖动的时间轴，可以边播边选取片段。')) return
        const input = ui.inputs[0]

        livePanel(ui, TRIM_DEFAULTS, () => ({
          runLabel: '导出片段',
          nodes: [
            { type: 'media', fileId: input.id, range: 'range' },
            {
              type: 'row', gap: 4, wrap: true, align: 'between',
              children: [
                { type: 'switch', bind: 'copy', label: '无损快切', hint: '不重新编码，速度极快；切点会对齐到最近的关键帧。' },
                {
                  type: 'segmented', bind: 'format', label: '输出格式',
                  options: [{ value: 'same', label: '原格式' }, { value: 'mp4', label: 'MP4' }, { value: 'mp3', label: 'MP3' }],
                },
              ],
            },
            { type: 'text', variant: 'muted', text: '提示：「播放选区」会从起点播到终点后停下，便于确认切点。' },
          ],
        }), [])
      },

      async run(ctx) {
        ctx.params = withDefaults(ctx.params, TRIM_DEFAULTS)
        const input = ctx.inputs[0]
        const [start = 0, end] = Array.isArray(ctx.params.range) ? ctx.params.range : []
        if (end !== undefined && end <= start) throw new Error('终点必须晚于起点')

        const format = String(ctx.params.format || 'same')
        const extension = format === 'same' ? extensionOf(input.name) : `.${format}`
        // Re-encoding is required whenever the container/codec changes.
        const copy = ctx.params.copy && format === 'same'
        const span = end !== undefined ? ['-to', String(end)] : []

        let args
        if (copy) {
          // -ss before -i seeks by keyframe (fast, lossless).
          args = ['-ss', String(start), '-i', '$in0', ...(end !== undefined ? ['-t', String(end - start)] : []), '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-y', '$out0']
        } else if (format === 'mp3') {
          await requireAudio(input, '导出 MP3')
          args = ['-i', '$in0', '-ss', String(start), ...span, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-y', '$out0']
        } else {
          args = ['-i', '$in0', '-ss', String(start), ...span, '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', '$out0']
        }

        const name = `${baseName(input.name)}-${clockName(start)}-${clockName(end ?? 0)}${extension}`
        const result = await runMediaFfmpeg({ args, inputs: [input.id], outputs: [name], label: `导出 ${input.name} 的片段` })
        return { outputs: [result.files[0].id], summary: `已导出 ${formatSpan(start)} → ${end !== undefined ? formatSpan(end) : '结尾'} 的片段` }
      },
    },

    {
      id: 'extract-audio',
      name: '提取音轨',
      category: 'media',
      icon: 'music',
      description: '从视频中分离音频，或在音频格式之间互转。',
      accept: ['video/*', 'audio/*', '.mkv', '.mov', '.avi', '.webm', '.m4a', '.flac', '.aac', '.ogg'],
      multiple: true,
      keywords: ['audio', 'extract', 'mp3', 'wav', 'flac', 'aac', '提取', '音频', '音轨', '转mp3'],
      params: [
        {
          key: 'format', type: 'select', label: '输出格式', default: 'mp3',
          options: [
            { value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV（无损，体积大）' },
            { value: 'flac', label: 'FLAC（无损压缩）' }, { value: 'aac', label: 'AAC / M4A' },
            { value: 'ogg', label: 'OGG Vorbis' }, { value: 'opus', label: 'Opus' },
          ],
        },
        {
          key: 'bitrate', type: 'select', label: '码率', default: '192k',
          options: [
            { value: '320k', label: '320 kbps（最高）' }, { value: '256k', label: '256 kbps' },
            { value: '192k', label: '192 kbps（推荐）' }, { value: '128k', label: '128 kbps' },
            { value: '96k', label: '96 kbps（语音）' },
          ],
          when: { key: 'format', equals: ['mp3', 'aac', 'ogg', 'opus'] },
        },
        { key: 'mono', type: 'switch', label: '转为单声道', default: false, hint: '语音内容可减半体积。' },
        { key: 'normalize', type: 'switch', label: '音量标准化', default: false, hint: 'EBU R128 响度归一化到 -16 LUFS。' },
      ],

      async run(ctx) {
        const p = ctx.params
        const outputs = []
        const CODECS = { mp3: 'libmp3lame', wav: 'pcm_s16le', flac: 'flac', aac: 'aac', ogg: 'libvorbis', opus: 'libopus' }
        const extension = p.format === 'aac' ? 'm4a' : String(p.format)

        const silent = []
        await eachInput(ctx, async (input, index) => {
          if (!(await hasAudio(input))) return void silent.push(input.name)
          const args = ['-i', '$in0', '-vn', '-c:a', CODECS[String(p.format)]]
          if (p.format !== 'wav' && p.format !== 'flac') args.push('-b:a', String(p.bitrate))
          if (p.mono) args.push('-ac', '1')

          const filters = []
          if (p.normalize) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11')
          if (filters.length) args.push('-af', filters.join(','))
          args.push('-y', '$out0')

          const name = `${baseName(input.name)}.${extension}`
          const result = await runMediaFfmpeg({
            args, inputs: [input.id], outputs: [name],
            label: `提取音轨 ${input.name}（${index + 1}/${ctx.inputs.length}）`,
          })
          outputs.push(result.files[0].id)
        })

        if (outputs.length === 0) throw new Error(noAudioMessage(silent, '提取音轨'))
        return { outputs, summary: `已导出 ${outputs.length} 个 ${extension.toUpperCase()} 音频${skippedNote(silent)}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'audio-edit',
      name: '音频处理',
      category: 'media',
      icon: 'waves',
      description: '音量、淡入淡出、变速、静音移除与声道——在波形上看到包络，导出前可直接试听。',
      accept: ['audio/*', 'video/*', '.m4a', '.flac', '.aac', '.ogg'],
      multiple: true,
      keywords: ['volume', 'normalize', 'fade', 'speed', 'silence', '音量', '标准化', '淡入', '淡出', '变速', '去静音'],

      async setup(ui) {
        if (!requireInputs(ui, 1, '先拖入音频或视频', '波形上会画出音量包络；播放时听到的就是处理后的效果。')) return
        // A time range is only meaningful for one file; a batch applies to whole files.
        const single = ui.inputs.length === 1

        livePanel(ui, AUDIO_EDIT_DEFAULTS, (state) => {
          const [duration = 0] = state.meta
          const [start = 0, end = duration] = single ? state.range : []
          const span = Math.max(0, end - start)
          const output = span / (Number(state.speed) / 100)
          const fadeMax = Math.max(1, Math.floor(span / 2)) || 30
          return {
            runLabel: single ? '导出音频' : `处理 ${ui.inputs.length} 个文件`,
            nodes: [
              {
                type: 'media', fileId: ui.inputs[0].id, meta: 'meta', height: 200,
                ...(single ? { range: 'range' } : {}),
                effects: {
                  volume: { bind: 'volume', scale: 0.01 }, speed: { bind: 'speed', scale: 0.01 },
                  fadeIn: 'fadeIn', fadeOut: 'fadeOut',
                },
              },
              ...(single ? [] : [{ type: 'alert', tone: 'info', text: `预览第一个文件；设置会应用到全部 ${ui.inputs.length} 个文件的完整时长。` }]),
              {
                type: 'section', title: '音量',
                children: [
                  { type: 'slider', bind: 'volume', label: '音量', min: 0, max: 400, step: 5, suffix: '%' },
                  { type: 'switch', bind: 'normalize', label: '响度标准化（EBU R128，-16 LUFS）', hint: '先标准化，再叠加上面的音量。' },
                ],
              },
              {
                type: 'section', title: '淡入淡出',
                children: [
                  { type: 'slider', bind: 'fadeIn', label: '淡入', min: 0, max: fadeMax, step: 0.1, suffix: ' 秒' },
                  { type: 'slider', bind: 'fadeOut', label: '淡出', min: 0, max: fadeMax, step: 0.1, suffix: ' 秒' },
                ],
              },
              {
                type: 'section', title: '速度与声道',
                children: [
                  { type: 'slider', bind: 'speed', label: '播放速度（不变调）', min: 25, max: 400, step: 5, suffix: '%' },
                  { type: 'slider', bind: 'pitch', label: '变调（不变速）', min: -12, max: 12, step: 1, suffix: ' 半音', hint: '预览不体现变调，以导出结果为准。' },
                  { type: 'switch', bind: 'denoise', label: '降低背景噪声', hint: '适合录音里的底噪、风扇声（预览不体现）。' },
                  { type: 'switch', bind: 'removeSilence', label: '移除静音段', hint: '低于 -50 dB 且超过 0.5 秒的停顿会被剪掉（预览不体现）。' },
                  { type: 'segmented', bind: 'channels', label: '声道', options: [{ value: 'keep', label: '保持' }, { value: '1', label: '单声道' }, { value: '2', label: '立体声' }] },
                  { type: 'segmented', bind: 'format', label: '输出格式', options: [{ value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV' }, { value: 'flac', label: 'FLAC' }, { value: 'm4a', label: 'M4A' }] },
                ],
              },
              ...(duration ? [{ type: 'facts', rows: [{ label: '输出时长', value: `${formatSpan(output)}${state.removeSilence ? '（移除静音前）' : ''}` }] }] : []),
            ],
          }
        }, ['meta', 'range', 'speed', 'removeSilence', 'pitch'])
      },

      async run(ctx) {
        ctx.params = withDefaults(ctx.params, AUDIO_EDIT_DEFAULTS)
        const p = ctx.params
        const outputs = []
        const CODECS = { mp3: 'libmp3lame', wav: 'pcm_s16le', flac: 'flac', m4a: 'aac' }
        const [rangeStart, rangeEnd] = ctx.inputs.length === 1 && Array.isArray(p.range) ? p.range : []

        const silent = []
        await eachInput(ctx, async (input, index) => {
          if (!(await hasAudio(input))) return void silent.push(input.name)
          const trimmed = rangeEnd !== undefined && rangeEnd > rangeStart
          let span
          if (trimmed) {
            span = rangeEnd - rangeStart
          } else if (Number(p.fadeOut) > 0) {
            span = (await host.ffmpeg.probe(input.id)).durationSeconds
          }

          // Fades are placed in source time, before anything that changes the
          // timeline (tempo, silence removal) - the same order the preview uses.
          const filters = []
          if (p.denoise) filters.push('afftdn=nf=-25')
          if (Number(p.fadeIn) > 0) filters.push(`afade=t=in:st=0:d=${Number(p.fadeIn)}`)
          if (Number(p.fadeOut) > 0 && span) filters.push(`afade=t=out:st=${Math.max(0, span - Number(p.fadeOut)).toFixed(3)}:d=${Number(p.fadeOut)}`)
          if (p.normalize) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11')
          if (Number(p.volume) !== 100) filters.push(`volume=${(Number(p.volume) / 100).toFixed(3)}`)
          const pitch = Math.round(Number(p.pitch) || 0)
          if (pitch) {
            // Resample to shift the pitch, then undo the tempo change that causes.
            const factor = 2 ** (pitch / 12)
            filters.push('aresample=48000', `asetrate=${Math.round(48000 * factor)}`, 'aresample=48000', ...tempoChain(1 / factor))
          }
          filters.push(...tempoChain(Number(p.speed) / 100))
          if (p.removeSilence) filters.push('silenceremove=start_periods=1:start_threshold=-50dB:stop_periods=-1:stop_threshold=-50dB:stop_duration=0.5')

          const args = [...(trimmed ? ['-ss', String(rangeStart), '-to', String(rangeEnd)] : []), '-i', '$in0', '-vn']
          if (filters.length) args.push('-af', filters.join(','))
          if (p.channels !== 'keep') args.push('-ac', String(p.channels))
          args.push('-c:a', CODECS[String(p.format)] ?? 'libmp3lame')
          if (p.format === 'mp3' || p.format === 'm4a') args.push('-b:a', '192k')
          args.push('-y', '$out0')

          const name = `${baseName(input.name)}-edited.${p.format}`
          const result = await runMediaFfmpeg({
            args, inputs: [input.id], outputs: [name],
            label: `处理 ${input.name}（${index + 1}/${ctx.inputs.length}）`,
          })
          outputs.push(result.files[0].id)
        })

        if (outputs.length === 0) throw new Error(noAudioMessage(silent, '处理音频'))
        return { outputs, summary: `已处理 ${outputs.length} 个音频${skippedNote(silent)}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'video-edit',
      name: '视频画面处理',
      category: 'media',
      icon: 'crop',
      description: '拖框裁切画面、旋转镜像、调色、变速、截取与去音轨，所见即所得地预览。',
      accept: ['video/*', '.mkv', '.mov', '.avi', '.webm'],
      multiple: true,
      keywords: ['crop', 'rotate', 'flip', 'speed', 'mute', 'color', '裁切', '旋转', '镜像', '调色', '变速', '静音'],

      async setup(ui) {
        if (!requireInputs(ui, 1, '先拖入视频', '画面上可以直接拖动裁切框，旋转、镜像和调色会实时预览。')) return
        const single = ui.inputs.length === 1

        livePanel(ui, VIDEO_EDIT_DEFAULTS, (state) => {
          const [duration = 0, width = 0, height = 0] = state.meta
          const facts = []
          if (width) {
            const size = outputSize(width, height, state.cropOn ? state.crop : [], state.rotate)
            facts.push({ label: '输出尺寸', value: `${size.width} × ${size.height}` })
          }
          if (duration) {
            const [start = 0, end = duration] = single ? state.range : []
            facts.push({ label: '输出时长', value: formatSpan((end - start) / (Number(state.speed) / 100)) })
          }
          return {
            runLabel: single ? '导出视频' : `处理 ${ui.inputs.length} 个视频`,
            nodes: [
              {
                type: 'media', fileId: ui.inputs[0].id, meta: 'meta', height: 360,
                ...(single ? { range: 'range' } : {}),
                crop: 'crop', cropAspect: 'cropAspect',
                effects: {
                  rotate: 'rotate', flipH: 'flipH', flipV: 'flipV',
                  brightness: { bind: 'brightness', scale: 0.01 }, contrast: { bind: 'contrast', scale: 0.01 },
                  saturation: { bind: 'saturation', scale: 0.01 }, hue: 'hue',
                  speed: { bind: 'speed', scale: 0.01 }, mute: 'mute',
                },
              },
              ...(single ? [] : [{ type: 'alert', tone: 'info', text: `预览第一个视频。裁切按画面比例记录，会等比应用到全部 ${ui.inputs.length} 个视频。` }]),
              {
                type: 'section', title: '裁切',
                children: [
                  { type: 'switch', bind: 'cropOn', label: '裁切画面', hint: '拖动框体移动，拖动边角调整大小；选中框体后可用方向键微调。' },
                  {
                    type: 'segmented', bind: 'aspectPreset', label: '比例', when: { key: 'cropOn', equals: true },
                    options: ASPECTS.map((a) => ({ value: a.value, label: a.label })),
                  },
                ],
              },
              {
                type: 'section', title: '方向',
                children: [
                  {
                    type: 'segmented', bind: 'rotate', label: '旋转',
                    options: [{ value: '0', label: '0°' }, { value: '90', label: '90°' }, { value: '180', label: '180°' }, { value: '270', label: '270°' }],
                  },
                  {
                    type: 'row', gap: 6, wrap: true,
                    children: [
                      { type: 'switch', bind: 'flipH', label: '水平镜像' },
                      { type: 'switch', bind: 'flipV', label: '垂直翻转' },
                    ],
                  },
                ],
              },
              {
                type: 'section', title: '调色',
                children: [
                  { type: 'slider', bind: 'brightness', label: '亮度', min: -50, max: 50, suffix: '' },
                  { type: 'slider', bind: 'contrast', label: '对比度', min: 50, max: 200, step: 5, suffix: '%' },
                  { type: 'slider', bind: 'saturation', label: '饱和度', min: 0, max: 300, step: 5, suffix: '%' },
                  { type: 'slider', bind: 'hue', label: '色相', min: -180, max: 180, step: 5, suffix: '°' },
                  { type: 'button', text: '重置调色', action: 'reset-color', variant: 'ghost', icon: 'refresh' },
                ],
              },
              {
                type: 'section', title: '速度与声音',
                children: [
                  { type: 'slider', bind: 'speed', label: '播放速度', min: 25, max: 400, step: 5, suffix: '%' },
                  { type: 'switch', bind: 'mute', label: '移除音轨' },
                ],
              },
              ...(facts.length ? [{ type: 'facts', rows: facts }] : []),
            ],
          }
        }, ['meta', 'range', 'crop', 'cropOn', 'rotate', 'speed'], {
          onChange(key, value, state) {
            if (key === 'cropOn') {
              // Start from the largest box of the chosen ratio, so turning crop
              // on never shows a box the user has to hunt for.
              ui.setState({ crop: value ? [0.1, 0.1, 0.8, 0.8] : [] })
            }
            if (key === 'aspectPreset') {
              const preset = ASPECTS.find((a) => a.value === value) ?? ASPECTS[0]
              ui.setState({ cropAspect: preset.ratio })
            }
          },
          onAction(name) {
            if (name === 'reset-color') ui.setState({ brightness: 0, contrast: 100, saturation: 100, hue: 0 })
          },
        })
      },

      async run(ctx) {
        ctx.params = withDefaults(ctx.params, VIDEO_EDIT_DEFAULTS)
        const p = ctx.params
        const outputs = []
        const speed = Number(p.speed ?? 100) / 100
        const [rangeStart, rangeEnd] = ctx.inputs.length === 1 && Array.isArray(p.range) ? p.range : []
        const trimmed = rangeEnd !== undefined && rangeEnd > rangeStart

        // Order matters and matches the preview: crop is drawn on the source
        // frame, then the result is rotated and flipped, then graded.
        const filters = []
        const crop = p.cropOn && Array.isArray(p.crop) && p.crop.length === 4 ? p.crop : null
        if (crop) filters.push(cropFilter(crop))
        const angle = Number(p.rotate)
        if (angle === 90) filters.push('transpose=1')
        else if (angle === 270) filters.push('transpose=2')
        else if (angle === 180) filters.push('hflip,vflip')
        if (p.flipH) filters.push('hflip')
        if (p.flipV) filters.push('vflip')

        const eq = []
        if (Number(p.brightness)) eq.push(`brightness=${(Number(p.brightness) / 100).toFixed(3)}`)
        if (Number(p.contrast ?? 100) !== 100) eq.push(`contrast=${(Number(p.contrast) / 100).toFixed(3)}`)
        if (Number(p.saturation ?? 100) !== 100) eq.push(`saturation=${(Number(p.saturation) / 100).toFixed(3)}`)
        if (eq.length) filters.push(`eq=${eq.join(':')}`)
        if (Number(p.hue)) filters.push(`hue=h=${Number(p.hue)}`)
        if (speed !== 1) filters.push(`setpts=PTS/${speed.toFixed(4)}`)

        await eachInput(ctx, async (input, index) => {
          const args = [...(trimmed ? ['-ss', String(rangeStart), '-to', String(rangeEnd)] : []), '-i', '$in0']
          if (filters.length) args.push('-vf', filters.join(','))
          args.push('-c:v', 'libx264', '-crf', '21', '-preset', 'medium', '-pix_fmt', 'yuv420p')

          if (p.mute) args.push('-an')
          else if (speed !== 1) args.push('-af', tempoChain(speed).join(','), '-c:a', 'aac', '-b:a', '128k')
          else args.push('-c:a', 'aac', '-b:a', '128k')
          args.push('-movflags', '+faststart', '-y', '$out0')

          const name = `${baseName(input.name)}-edited.mp4`
          const result = await runMediaFfmpeg({
            args, inputs: [input.id], outputs: [name],
            label: `处理 ${input.name}（${index + 1}/${ctx.inputs.length}）`,
          })
          outputs.push(result.files[0].id)
        })

        return { outputs, summary: `已处理 ${outputs.length} 个视频` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'to-gif',
      name: '视频转 GIF / WebP',
      category: 'media',
      icon: 'film',
      description: '在时间轴上选出片段、拖框裁切，再转成 GIF、动态 WebP 或 APNG；GIF 使用调色板算法保证画质。',
      accept: ['video/*', '.mkv', '.mov', '.avi', '.webm'],
      multiple: false,
      keywords: ['gif', 'webp', 'animation', '动图', '表情包'],

      async setup(ui) {
        if (!requireInputs(ui, 1, '先拖入一个视频', '选出一小段并裁掉多余画面，动图会更小、更清晰。')) return

        livePanel(ui, GIF_DEFAULTS, (state) => {
          const [duration = 0, sourceWidth = 0, sourceHeight = 0] = state.meta
          const [start = 0, end = duration] = state.range
          const span = Math.max(0, end - start)
          const frames = Math.round(span * Number(state.fps))
          const facts = []
          if (duration) facts.push({ label: '片段时长', value: formatSpan(span) }, { label: '帧数', value: String(frames) })
          if (sourceWidth) {
            const cropped = outputSize(sourceWidth, sourceHeight, state.cropOn ? state.crop : [], '0')
            const width = Math.min(Number(state.width), cropped.width)
            facts.push({ label: '输出尺寸', value: `${width} × ${Math.round((width * cropped.height) / cropped.width)}` })
          }
          return {
            runLabel: `生成 ${String(state.format).toUpperCase()}`,
            nodes: [
              { type: 'media', fileId: ui.inputs[0].id, range: 'range', meta: 'meta', crop: 'crop', cropAspect: 'cropAspect', height: 320 },
              {
                type: 'row', gap: 6, wrap: true, align: 'between',
                children: [
                  { type: 'segmented', bind: 'format', label: '格式', options: [{ value: 'gif', label: 'GIF' }, { value: 'webp', label: '动态 WebP（更小）' }, { value: 'apng', label: 'APNG' }] },
                  { type: 'switch', bind: 'loop', label: '循环播放' },
                ],
              },
              { type: 'slider', bind: 'fps', label: '帧率', min: 5, max: 30, suffix: ' fps' },
              { type: 'slider', bind: 'width', label: '最大宽度', min: 120, max: 1280, step: 10, suffix: ' px', hint: '高度按比例计算；不会放大到超过原画面。' },
              { type: 'switch', bind: 'cropOn', label: '裁切画面' },
              { type: 'segmented', bind: 'aspectPreset', label: '比例', when: { key: 'cropOn', equals: true }, options: ASPECTS.map((a) => ({ value: a.value, label: a.label })) },
              ...(facts.length ? [{ type: 'facts', rows: facts }] : []),
              ...(frames > 600 ? [{ type: 'alert', tone: 'warning', title: '帧数较多', text: '超过 600 帧的动图生成慢、体积大。可以缩短片段或降低帧率。' }] : []),
            ],
          }
        }, ['meta', 'range', 'crop', 'cropOn', 'fps', 'width', 'format'], {
          onChange(key, value, state) {
            // A fresh file selects all of it; for an animation, the first few
            // seconds are a far better starting point.
            if (key === 'meta' && Array.isArray(value) && value[0] > 5 && !ui.touchedRange) {
              ui.setState({ range: [0, 5] })
            }
            if (key === 'range') ui.touchedRange = true
            if (key === 'cropOn') ui.setState({ crop: value ? [0.1, 0.1, 0.8, 0.8] : [] })
            if (key === 'aspectPreset') ui.setState({ cropAspect: (ASPECTS.find((a) => a.value === value) ?? ASPECTS[0]).ratio })
          },
        })
      },

      async run(ctx) {
        ctx.params = withDefaults(ctx.params, GIF_DEFAULTS)
        const p = ctx.params
        const input = ctx.inputs[0]
        const [start = 0, end] = Array.isArray(p.range) ? p.range : []
        if (end !== undefined && end <= start) throw new Error('终点必须晚于起点')
        const seek = ['-ss', String(start), ...(end !== undefined ? ['-t', String(end - start)] : ['-t', '5'])]

        const chain = []
        if (p.cropOn && Array.isArray(p.crop) && p.crop.length === 4) chain.push(cropFilter(p.crop))
        chain.push(`fps=${Number(p.fps)}`, `scale='min(${Number(p.width)},iw)':-1:flags=lanczos`)
        const scale = chain.join(',')

        const name = `${baseName(input.name)}.${p.format === 'apng' ? 'png' : p.format}`
        const label = `生成动图 ${input.name}`
        let result
        if (p.format === 'gif') {
          // A generated palette is the difference between a usable GIF and a
          // dithered mess; it needs its own pass over the clip. The palette
          // comes back as a workspace file, which the second pass mounts.
          const paletteRun = await runMediaFfmpeg({
            args: [...seek, '-i', '$in0', '-vf', `${scale},palettegen=stats_mode=diff`, '-y', '$out0'],
            inputs: [input.id], outputs: ['palette.png'], label: `${label} · 生成调色板`,
          })
          const palette = paletteRun.files[0]
          try {
            result = await runMediaFfmpeg({
              args: [
                ...seek, '-i', '$in0', '-i', '$in1',
                '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
                '-loop', p.loop ? '0' : '-1', '-y', '$out0',
              ],
              inputs: [input.id, palette.id], outputs: [name], label,
            })
          } finally {
            // Palettes are scaffolding, not results.
            await host.fs.remove(palette.id).catch(() => {})
          }
        } else if (p.format === 'apng') {
          result = await runMediaFfmpeg({
            args: [...seek, '-i', '$in0', '-vf', scale, '-c:v', 'apng', '-plays', p.loop ? '0' : '1', '-f', 'apng', '-an', '-y', '$out0'],
            inputs: [input.id], outputs: [name], label,
          })
        } else {
          result = await runMediaFfmpeg({
            args: [...seek, '-i', '$in0', '-vf', scale, '-c:v', 'libwebp', '-lossless', '0', '-q:v', '70', '-loop', p.loop ? '0' : '1', '-an', '-y', '$out0'],
            inputs: [input.id], outputs: [name], label,
          })
        }

        return { outputs: [result.files[0].id], summary: `已生成 1 个动图（${bytesLabel(result.files[0].size)}）` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'frames',
      name: '视频抽帧',
      category: 'media',
      icon: 'image',
      description: '边播边标记想要的画面逐帧导出，或在选定范围内按间隔、按数量均匀抽取。',
      accept: ['video/*', '.mkv', '.mov', '.avi', '.webm'],
      multiple: false,
      keywords: ['frames', 'thumbnail', 'screenshot', 'poster', '抽帧', '截图', '封面'],

      async setup(ui) {
        if (!requireInputs(ui, 1, '先拖入一个视频', '播放到想要的画面点「标记当前帧」，或者选一段范围批量抽取。')) return

        livePanel(ui, FRAMES_DEFAULTS, (state) => {
          const marked = state.mode === 'marked'
          const [duration = 0] = state.meta
          const [start = 0, end = duration] = state.range
          const span = Math.max(0, end - start)
          let estimate = state.markers.length
          if (state.mode === 'interval') estimate = Math.min(500, Math.floor(span / Math.max(0.1, Number(state.interval))) + 1)
          if (state.mode === 'count') estimate = Number(state.count)

          return {
            runLabel: estimate ? `导出 ${estimate} 帧` : '导出',
            runDisabled: marked && state.markers.length === 0,
            nodes: [
              {
                type: 'segmented', bind: 'mode', label: '方式',
                options: [{ value: 'marked', label: '手动标记' }, { value: 'interval', label: '按间隔' }, { value: 'count', label: '均匀 N 张' }],
              },
              { type: 'media', fileId: ui.inputs[0].id, meta: 'meta', height: 320, ...(marked ? { markers: 'markers' } : { range: 'range' }) },
              { type: 'input', bind: 'interval', label: '间隔', inputType: 'number', min: 0.1, step: 0.5, suffix: '秒', when: { key: 'mode', equals: 'interval' } },
              { type: 'input', bind: 'count', label: '数量', inputType: 'number', min: 1, max: 200, when: { key: 'mode', equals: 'count' } },
              {
                type: 'row', gap: 6, wrap: true,
                children: [
                  { type: 'segmented', bind: 'format', label: '格式', options: [{ value: 'jpg', label: 'JPEG' }, { value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP' }] },
                  { type: 'input', bind: 'width', label: '宽度', inputType: 'number', min: 0, suffix: 'px', hint: '0 为原始尺寸' },
                ],
              },
            ],
          }
        }, ['mode', 'markers', 'range', 'meta', 'interval', 'count'])
      },

      async run(ctx) {
        ctx.params = withDefaults(ctx.params, FRAMES_DEFAULTS)
        const p = ctx.params
        const input = ctx.inputs[0]
        const base = baseName(input.name)
        const scale = Number(p.width) > 0 ? `scale=${Number(p.width)}:-2:flags=lanczos` : ''

        if (p.mode === 'marked' || p.mode === 'single') {
          // `single` + `at` is the pre-panel parameter shape, kept for callers.
          const times = p.mode === 'single' ? [parseClock(String(p.at ?? '0'))] : (Array.isArray(p.markers) ? p.markers : [])
          if (times.length === 0) throw new Error('请先在时间轴上标记至少一帧')
          const outputs = []
          for (const [index, at] of times.entries()) {
            ctx.throwIfAborted()
            const result = await runMediaFfmpeg({
              args: ['-ss', String(at), '-i', '$in0', ...(scale ? ['-vf', scale] : []), '-frames:v', '1', '-y', '$out0'],
              inputs: [input.id], outputs: [`${base}-${stampName(at)}.${p.format}`],
              label: `导出第 ${index + 1}/${times.length} 帧`,
            })
            outputs.push(result.files[0].id)
          }
          return { outputs, summary: p.mode === 'single' ? '已提取封面' : `已导出 ${outputs.length} 帧` }
        }

        const [start = 0, end] = Array.isArray(p.range) ? p.range : []
        const window = [...(start > 0 ? ['-ss', String(start)] : []), ...(end !== undefined ? ['-to', String(end)] : [])]

        let rate
        if (p.mode === 'interval') {
          rate = `fps=1/${Math.max(0.1, Number(p.interval))}`
        } else {
          const duration = end !== undefined ? end - start : (await host.ffmpeg.probe(input.id)).durationSeconds
          if (!duration) throw new Error('无法读取视频时长，请改用「按间隔」')
          rate = `fps=${(Number(p.count) / duration).toFixed(6)}`
        }

        const filters = [rate, scale].filter(Boolean).join(',')
        // The frame count is not knowable in advance, so declare a sequence
        // pattern and let the host collect whatever ffmpeg actually wrote.
        const limit = p.mode === 'count' ? Number(p.count) : 500
        const result = await runMediaFfmpeg({
          args: [...window, '-i', '$in0', '-vf', filters, '-fps_mode', 'vfr', '-frames:v', String(limit), '-y', '$out0'],
          inputs: [input.id], outputs: [`${base}-%04d.${p.format}`], label: '抽帧中',
        })

        return { outputs: result.files.map((f) => f.id), summary: `已导出 ${result.files.length} 帧` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'merge',
      name: '合并音视频',
      category: 'media',
      icon: 'merge',
      description: '拖动排序后首尾拼接（分辨率不同也能拼），或把一段音频配到视频上。',
      accept: ['video/*', 'audio/*', '.mkv', '.mov', '.avi', '.webm', '.m4a', '.mp3', '.wav', '.flac'],
      multiple: true,
      minFiles: 2,
      keywords: ['merge', 'concat', 'join', '合并', '拼接', '配音'],

      async setup(ui) {
        if (!requireInputs(ui, 2, '至少拖入两个文件', '拼接会按下方列表的顺序进行，可以拖动或用箭头调整。')) return
        const allAudio = ui.inputs.every(isAudio)
        const mixed = !allAudio && ui.inputs.some(isAudio)

        livePanel(ui, { mode: 'concat', order: ui.inputs.map((_, i) => i), outputName: allAudio ? 'merged.mp3' : 'merged.mp4' }, (state) => {
          const order = validOrder(state.order, ui.inputs.length)
          const first = ui.inputs[order[0]]
          const replace = state.mode === 'replace-audio'
          return {
            runLabel: replace ? '替换音轨' : `拼接 ${ui.inputs.length} 个片段`,
            runDisabled: mixed && !replace,
            nodes: [
              {
                type: 'segmented', bind: 'mode', label: '方式',
                options: [{ value: 'concat', label: '首尾拼接' }, { value: 'replace-audio', label: '替换音轨' }],
              },
              {
                type: 'reorder', bind: 'order', label: replace ? '第 1 项提供画面，第 2 项提供声音' : '拼接顺序',
                items: ui.inputs.map((input) => ({ label: input.name, detail: `${isAudio(input) ? '音频' : '视频'} · ${bytesLabel(input.size)}` })),
              },
              { type: 'media', fileId: first.id, height: 200 },
              { type: 'text', variant: 'muted', text: `预览：列表第一项「${first.name}」` },
              ...(mixed && !replace
                ? [{ type: 'alert', tone: 'warning', title: '视频与纯音频不能首尾拼接', text: '纯音频没有画面可接。要给视频配音，请切换到「替换音轨」。' }]
                : []),
              { type: 'input', bind: 'outputName', label: '输出文件名' },
              ...(allAudio || replace
                ? []
                : [{ type: 'text', variant: 'muted', text: '分辨率或帧率不同的视频会统一到第一个片段的尺寸（不足部分加黑边）；没有音轨的视频会补静音。' }]),
            ],
          }
        }, ['order', 'mode'])
      },

      async run(ctx) {
        ctx.params = withDefaults(ctx.params, { mode: 'concat', order: [], outputName: '' })
        const order = validOrder(ctx.params.order, ctx.inputs.length)
        const inputs = order.map((i) => ctx.inputs[i])
        const allAudio = inputs.every(isAudio)
        const name = String(ctx.params.outputName || (allAudio ? 'merged.mp3' : 'merged.mp4'))

        if (ctx.params.mode === 'replace-audio') {
          if (inputs.length < 2) throw new Error('需要两个文件：第 1 个提供画面，第 2 个提供声音')
          const result = await runMediaFfmpeg({
            args: ['-i', '$in0', '-i', '$in1', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-y', '$out0'],
            inputs: [inputs[0].id, inputs[1].id], outputs: [name], label: '替换音轨',
          })
          return { outputs: [result.files[0].id], summary: '已替换音轨' }
        }

        if (!allAudio && inputs.some(isAudio)) throw new Error('视频与纯音频不能首尾拼接；要给视频配音请使用「替换音轨」')

        const n = inputs.length
        const args = []
        for (let i = 0; i < n; i++) args.push('-i', `$in${i}`)

        if (allAudio) {
          const chain = inputs.map((_, i) => `[${i}:a:0]aresample=48000,aformat=channel_layouts=stereo[a${i}]`).join(';')
          const joined = inputs.map((_, i) => `[a${i}]`).join('')
          args.push('-filter_complex', `${chain};${joined}concat=n=${n}:v=0:a=1[a]`, '-map', '[a]')
          if (/\.mp3$/i.test(name)) args.push('-c:a', 'libmp3lame', '-b:a', '192k')
          args.push('-y', '$out0')
        } else {
          // The concat filter needs every segment to agree on size, SAR, frame
          // rate and audio layout - arbitrary user files never do. Normalise each
          // to the first clip, and give silent clips a silent track.
          const probes = []
          for (const input of inputs) probes.push(await host.ffmpeg.probe(input.id))
          const width = even(probes[0].width || 1280)
          const height = even(probes[0].height || 720)

          const parts = []
          const joined = []
          inputs.forEach((_, i) => {
            parts.push(`[${i}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`)
            if (probes[i].audioCodec) {
              parts.push(`[${i}:a:0]aresample=48000,aformat=channel_layouts=stereo[a${i}]`)
            } else {
              const seconds = Math.max(0.1, probes[i].durationSeconds || 1)
              parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${seconds.toFixed(3)}[a${i}]`)
            }
            joined.push(`[v${i}][a${i}]`)
          })
          args.push(
            '-filter_complex', `${parts.join(';')};${joined.join('')}concat=n=${n}:v=1:a=1[v][a]`,
            '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '21', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '160k',
            '-movflags', '+faststart', '-y', '$out0',
          )
        }

        const result = await runMediaFfmpeg({
          args, inputs: inputs.map((i) => i.id), outputs: [name], label: `拼接 ${n} 个片段`,
        })
        return { outputs: [result.files[0].id], summary: `已拼接 ${n} 个片段` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'video-effects',
      name: '视频特效与修复',
      category: 'media',
      icon: 'wand',
      description: '倒放、帧率转换、模糊背景补成竖屏 / 方形、防抖、降噪，以及清除拍摄设备与定位等元数据。',
      accept: ['video/*', '.mkv', '.mov', '.avi', '.webm'],
      multiple: true,
      keywords: ['reverse', 'fps', 'frame rate', 'blur background', 'vertical', 'stabilize', 'deshake', 'denoise', 'metadata', '倒放', '帧率', '竖屏', '模糊背景', '防抖', '降噪', '去元数据'],
      params: [
        {
          key: 'effect', type: 'select', label: '效果', default: 'blurpad',
          options: [
            { value: 'blurpad', label: '模糊背景补边（横屏转竖屏 / 方形）' },
            { value: 'reverse', label: '倒放' },
            { value: 'fps', label: '帧率转换' },
            { value: 'stabilize', label: '画面防抖' },
            { value: 'denoise', label: '画面降噪' },
            { value: 'metadata', label: '清除元数据（设备、定位、创建时间）' },
          ],
        },
        {
          key: 'aspect', type: 'select', label: '目标比例', default: '9:16',
          options: [{ value: '9:16', label: '9:16 竖屏' }, { value: '1:1', label: '1:1 方形' }, { value: '4:5', label: '4:5' }, { value: '16:9', label: '16:9 横屏' }],
          when: { key: 'effect', equals: 'blurpad' },
        },
        { key: 'blur', type: 'slider', label: '背景模糊', min: 5, max: 60, default: 25, when: { key: 'effect', equals: 'blurpad' } },
        { key: 'fps', type: 'select', label: '目标帧率', default: '30', options: ['15', '24', '25', '30', '50', '60'].map((v) => ({ value: v, label: `${v} fps` })), when: { key: 'effect', equals: 'fps' } },
        { key: 'reverseAudio', type: 'switch', label: '声音一起倒放', default: true, when: { key: 'effect', equals: 'reverse' }, hint: '倒放需要把整段视频读入内存，建议用于 1 分钟以内的片段。' },
        { key: 'strength', type: 'select', label: '强度', default: 'medium', options: [{ value: 'light', label: '轻' }, { value: 'medium', label: '中' }, { value: 'strong', label: '强' }], when: { key: 'effect', equals: ['stabilize', 'denoise'] } },
      ],

      async run(ctx) {
        const p = ctx.params
        const outputs = []
        const effect = String(p.effect)

        await eachInput(ctx, async (input, index) => {
          const label = `${EFFECT_LABELS[effect] ?? '处理'} ${input.name}（${index + 1}/${ctx.inputs.length}）`
          let args
          let extension = '.mp4'

          if (effect === 'metadata') {
            // Streams are copied untouched; only the container metadata goes.
            extension = extensionOf(input.name)
            args = ['-i', '$in0', '-map', '0', '-map_metadata', '-1', '-map_chapters', '-1', '-c', 'copy', '-fflags', '+bitexact', '-y', '$out0']
          } else {
            const video = []
            const audio = []
            if (effect === 'blurpad') {
              const [aw, ah] = String(p.aspect).split(':').map(Number)
              const probe = await host.ffmpeg.probe(input.id)
              if (!probe.width || !probe.height) throw new Error(`${input.name}：无法读取画面尺寸`)
              // Keep the source's long edge: a 1920×1080 clip becomes 1080×1920, not an upscale.
              const wider = probe.width / probe.height > aw / ah
              const W = even(wider ? (probe.height * aw) / ah : probe.width)
              const H = even(wider ? probe.height : (probe.width * ah) / aw)
              const sigma = Math.max(1, Number(p.blur) || 25)
              const graph =
                `[0:v]split=2[bg][fg];` +
                `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=${sigma}[b];` +
                `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[f];` +
                `[b][f]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]`
              args = ['-i', '$in0', '-filter_complex', graph, '-map', '[v]', '-map', '0:a?']
            } else {
              if (effect === 'reverse') {
                video.push('reverse')
                if (p.reverseAudio) audio.push('areverse')
              } else if (effect === 'fps') {
                video.push(`fps=${Number(p.fps) || 30}`)
              } else if (effect === 'stabilize') {
                const r = { light: 8, medium: 16, strong: 32 }[String(p.strength)] ?? 16
                video.push(`deshake=rx=${r}:ry=${r}:edge=mirror`)
              } else if (effect === 'denoise') {
                video.push({ light: 'hqdn3d=2:1.5:3:3', medium: 'hqdn3d=4:3:6:4.5', strong: 'hqdn3d=8:6:12:9' }[String(p.strength)] ?? 'hqdn3d')
              }
              args = ['-i', '$in0', '-vf', video.join(',')]
              if (audio.length) args.push('-af', audio.join(','))
            }
            args.push('-c:v', 'libx264', '-crf', '21', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', '$out0')
          }

          const suffix = { blurpad: `-${String(p.aspect).replace(':', 'x')}`, reverse: '-reversed', fps: `-${p.fps}fps`, stabilize: '-stabilized', denoise: '-denoised', metadata: '-clean' }[effect] ?? '-effect'
          const result = await runMediaFfmpeg({ args, inputs: [input.id], outputs: [`${baseName(input.name)}${suffix}${extension}`], label })
          outputs.push(result.files[0].id)
        })

        return { outputs, summary: `已处理 ${outputs.length} 个视频` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'audio-split',
      name: '音频分割与铃声',
      category: 'media',
      icon: 'scissors',
      description: '在波形上标记切点把音频分成多段，或按固定时长均分；也可以直接导出 iPhone 铃声。',
      accept: ['audio/*', 'video/*', '.m4a', '.flac', '.aac', '.ogg', '.opus'],
      multiple: false,
      keywords: ['split', 'segment', 'ringtone', 'm4r', 'cut audio', '分割', '切分', '铃声', '分段'],

      async setup(ui) {
        if (!requireInputs(ui, 1, '先拖入一个音频或视频', '播放到想切开的位置点「标记当前帧」，每个标记都是一个切点。')) return
        const input = ui.inputs[0]
        livePanel(ui, SPLIT_DEFAULTS, (state) => {
          const [duration = 0] = state.meta
          const cuts = cutPoints(state, duration)
          const count = state.mode === 'ringtone' ? 1 : Math.max(1, cuts.length + 1)
          const alerts = []
          if (state.mode === 'ringtone' && duration) {
            const [start = 0, end = Math.min(duration, 30)] = state.range
            if (end - start > 40) alerts.push({ type: 'alert', tone: 'warning', title: '铃声超过 40 秒', text: 'iPhone 只接受 40 秒以内的铃声，导出时会截到 40 秒。' })
          }
          return {
            runLabel: state.mode === 'ringtone' ? '导出铃声' : `导出 ${count} 段`,
            runDisabled: state.mode === 'marks' && state.markers.length === 0,
            nodes: [
              {
                type: 'segmented', bind: 'mode', label: '方式',
                options: [{ value: 'marks', label: '按标记切分' }, { value: 'length', label: '按时长均分' }, { value: 'ringtone', label: '制作铃声' }],
              },
              {
                type: 'media', fileId: input.id, meta: 'meta', height: 180,
                ...(state.mode === 'marks' ? { markers: 'markers' } : state.mode === 'ringtone' ? { range: 'range' } : {}),
              },
              { type: 'input', bind: 'length', label: '每段时长', inputType: 'number', min: 1, suffix: '秒', when: { key: 'mode', equals: 'length' } },
              {
                type: 'segmented', bind: 'format', label: '输出格式', when: { key: 'mode', equals: ['marks', 'length'] },
                options: [{ value: 'mp3', label: 'MP3' }, { value: 'm4a', label: 'M4A' }, { value: 'wav', label: 'WAV' }],
              },
              { type: 'switch', bind: 'fade', label: '铃声首尾淡入淡出', when: { key: 'mode', equals: 'ringtone' } },
              ...(duration && state.mode !== 'ringtone' ? [{ type: 'facts', rows: [{ label: '段数', value: String(count) }, { label: '总时长', value: formatSpan(duration) }] }] : []),
              ...alerts,
            ],
          }
        }, ['mode', 'meta', 'markers', 'length', 'range'], {
          onChange(key, value) {
            // A ringtone starts as the first 30 seconds.
            if (key === 'meta' && Array.isArray(value) && !ui.touchedRange) ui.setState({ range: [0, Math.min(30, value[0])] })
            if (key === 'range') ui.touchedRange = true
          },
        })
      },

      async run(ctx) {
        ctx.params = withDefaults(ctx.params, SPLIT_DEFAULTS)
        const p = ctx.params
        const input = ctx.inputs[0]
        const base = baseName(input.name)
        await requireAudio(input, '分割音频')

        if (p.mode === 'ringtone') {
          const [start = 0, end] = p.range
          const stop = Math.min(end ?? start + 30, start + 40)
          const span = stop - start
          const filters = p.fade && span > 3 ? ['-af', `afade=t=in:st=0:d=1,afade=t=out:st=${(span - 1.5).toFixed(2)}:d=1.5`] : []
          const result = await runMediaFfmpeg({
            args: ['-ss', String(start), '-to', String(stop), '-i', '$in0', '-vn', ...filters, '-c:a', 'aac', '-b:a', '192k', '-f', 'ipod', '-y', '$out0'],
            inputs: [input.id], outputs: [`${base}.m4r`], label: '导出铃声',
          })
          return { outputs: [result.files[0].id], summary: `已导出 ${formatSpan(span)} 的 iPhone 铃声（在 Mac 或 iPhone 的「文件」中打开即可导入）` }
        }

        const probe = p.meta[0] ? { durationSeconds: p.meta[0] } : await host.ffmpeg.probe(input.id)
        const duration = probe.durationSeconds
        if (!duration) throw new Error('无法读取时长')
        const cuts = cutPoints(p, duration)
        if (p.mode === 'marks' && cuts.length === 0) throw new Error('请先在波形上标记至少一个切点')

        const bounds = [0, ...cuts, duration]
        const format = ['mp3', 'm4a', 'wav'].includes(String(p.format)) ? String(p.format) : 'mp3'
        const codec = { mp3: ['-c:a', 'libmp3lame', '-b:a', '192k'], m4a: ['-c:a', 'aac', '-b:a', '192k'], wav: ['-c:a', 'pcm_s16le'] }[format]
        const outputs = []
        for (let i = 0; i < bounds.length - 1; i++) {
          ctx.throwIfAborted()
          ctx.progress(i / (bounds.length - 1), `导出第 ${i + 1}/${bounds.length - 1} 段`)
          const result = await runMediaFfmpeg({
            // Re-encoding keeps every cut exactly where it was marked; stream copy snaps to packets.
            args: ['-ss', bounds[i].toFixed(3), '-to', bounds[i + 1].toFixed(3), '-i', '$in0', '-vn', ...codec, '-y', '$out0'],
            inputs: [input.id], outputs: [`${base}-${String(i + 1).padStart(2, '0')}.${format}`],
            label: `分割 ${input.name}（${i + 1}/${bounds.length - 1}）`,
          })
          outputs.push(result.files[0].id)
        }
        ctx.progress(1)
        return { outputs, summary: `已分割为 ${outputs.length} 段` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'waveform',
      name: '波形图与频谱图',
      category: 'media',
      icon: 'waves',
      description: '把音频画成波形图或声谱图 PNG，适合做封面、播客配图或检查录音问题。',
      accept: ['audio/*', 'video/*', '.m4a', '.flac', '.aac', '.ogg', '.opus'],
      multiple: true,
      keywords: ['waveform', 'spectrogram', 'spectrum', 'visualize', '波形', '频谱', '声谱'],
      params: [
        { key: 'kind', type: 'select', label: '类型', default: 'waveform', options: [{ value: 'waveform', label: '波形图' }, { value: 'spectrum', label: '声谱图（频率随时间）' }] },
        { key: 'width', type: 'number', label: '宽度', default: 1600, min: 200, max: 8000, suffix: 'px' },
        { key: 'height', type: 'number', label: '高度', default: 400, min: 100, max: 4000, suffix: 'px' },
        { key: 'color', type: 'text', label: '波形颜色', default: '#16a34a', when: { key: 'kind', equals: 'waveform' } },
        { key: 'split', type: 'switch', label: '左右声道分开显示', default: false, when: { key: 'kind', equals: 'waveform' } },
        { key: 'rate', type: 'select', label: '频率范围', default: '22050', when: { key: 'kind', equals: 'spectrum' }, options: [
          { value: '16000', label: '0–8 kHz（人声）' }, { value: '22050', label: '0–11 kHz' }, { value: '44100', label: '0–22 kHz（完整音乐细节）' },
        ] },
        { key: 'fscale', type: 'select', label: '频率刻度', default: 'lin', when: { key: 'kind', equals: 'spectrum' }, options: [
          { value: 'lin', label: '线性' }, { value: 'log', label: '对数（低频更细）' },
        ] },
      ],

      async run(ctx) {
        const p = ctx.params
        const outputs = []
        const size = `${Math.round(Number(p.width) || 1600)}x${Math.round(Number(p.height) || 400)}`
        const silent = []
        const notes = []
        await eachInput(ctx, async (input, index) => {
          // A video without an audio track (screen recordings, many WebM clips) has nothing to draw.
          if (!(await hasAudio(input))) return void silent.push(input.name)
          if (p.kind === 'spectrum') {
            const drawn = await drawSpectrogram(ctx, input, p, index)
            outputs.push(drawn.id)
            if (drawn.note) notes.push(drawn.note)
            return
          }
          const color = /^#?[0-9a-f]{6}$/i.test(String(p.color)) ? `0x${String(p.color).replace('#', '')}` : '0x16a34a'
          const filter = `showwavespic=s=${size}:colors=${color}:split_channels=${p.split ? 1 : 0}`
          const result = await runMediaFfmpeg({
            args: ['-i', '$in0', '-filter_complex', `[0:a:0]${filter}`, '-frames:v', '1', '-update', '1', '-y', '$out0'],
            inputs: [input.id], outputs: [`${baseName(input.name)}-${p.kind}.png`],
            label: `绘制 ${input.name}（${index + 1}/${ctx.inputs.length}）`,
          })
          outputs.push(result.files[0].id)
        })
        if (outputs.length === 0) throw new Error(noAudioMessage(silent, `绘制${p.kind === 'spectrum' ? '声谱图' : '波形图'}`))
        return { outputs, summary: `已生成 ${outputs.length} 张图${skippedNote(silent)}${notes.length ? `；${notes.join('；')}` : ''}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'images-to-video',
      name: '图片 / GIF 转视频',
      category: 'media',
      icon: 'film',
      description: '把多张图片按顺序做成幻灯片视频（可配乐、淡入淡出），或把 GIF 转成 MP4 / APNG。',
      accept: ['image/*', 'audio/*', '.m4a', '.mp3'],
      multiple: true,
      keywords: ['slideshow', 'images to video', 'gif to mp4', 'apng', 'photo video', '幻灯片', '图片转视频', 'gif转mp4', '相册视频'],

      async setup(ui) {
        if (!requireInputs(ui, 1, '拖入图片（可以再加一段音乐）', '图片按下方列表顺序出现；拖入的音频会作为背景音乐，视频长度以图片总时长为准。')) return
        const images = ui.inputs.filter((i) => !isAudio(i))
        const audio = ui.inputs.find(isAudio)
        const singleGif = images.length === 1 && /gif$/i.test(images[0].type || images[0].name)

        livePanel(ui, { ...SLIDESHOW_DEFAULTS, order: images.map((_, i) => i) }, (state) => {
          const total = singleGif ? null : images.length * Number(state.seconds)
          return {
            runLabel: singleGif ? `转换为 ${String(state.gifFormat).toUpperCase()}` : '生成视频',
            runDisabled: images.length === 0,
            nodes: singleGif
              ? [
                  { type: 'preview', fileId: images[0].id, height: 220 },
                  { type: 'segmented', bind: 'gifFormat', label: '输出', options: [{ value: 'mp4', label: 'MP4（体积小很多）' }, { value: 'apng', label: 'APNG（保留透明）' }, { value: 'webm', label: 'WebM' }] },
                  { type: 'slider', bind: 'loops', label: '重复次数', min: 1, max: 10, suffix: ' 次', when: { key: 'gifFormat', equals: ['mp4', 'webm'] } },
                ]
              : [
                  { type: 'reorder', bind: 'order', label: '播放顺序', items: images.map((i) => ({ label: i.name, detail: bytesLabel(i.size) })) },
                  { type: 'slider', bind: 'seconds', label: '每张时长', min: 0.5, max: 10, step: 0.5, suffix: ' 秒' },
                  {
                    type: 'segmented', bind: 'size', label: '画面尺寸',
                    options: [{ value: 'first', label: '跟随第一张' }, { value: '1920x1080', label: '16:9' }, { value: '1080x1920', label: '9:16' }, { value: '1080x1080', label: '1:1' }],
                  },
                  { type: 'switch', bind: 'fade', label: '每张淡入淡出' },
                  { type: 'color', bind: 'background', label: '留白颜色', hint: '图片比例与画面不同时填充的颜色。' },
                  { type: 'facts', rows: [{ label: '图片', value: `${images.length} 张` }, { label: '视频时长', value: formatSpan(total) }, { label: '背景音乐', value: audio ? audio.name : '无' }] },
                ],
          }
        }, ['order', 'seconds', 'gifFormat'])
      },

      async run(ctx) {
        const p = withDefaults(ctx.params, SLIDESHOW_DEFAULTS)
        const images = ctx.inputs.filter((i) => !isAudio(i))
        const audio = ctx.inputs.find(isAudio)
        if (images.length === 0) throw new Error('请至少拖入一张图片')

        if (images.length === 1 && /gif$/i.test(images[0].type || images[0].name) && !audio) {
          const gif = images[0]
          const base = baseName(gif.name)
          const format = String(p.gifFormat)
          const loop = format === 'apng' ? [] : ['-stream_loop', String(Math.max(0, (Number(p.loops) || 1) - 1))]
          const codec = {
            mp4: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart'],
            webm: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32'],
            apng: ['-c:v', 'apng', '-plays', '0', '-f', 'apng'],
          }[format]
          const result = await runMediaFfmpeg({ args: [...loop, '-i', '$in0', ...codec, '-an', '-y', '$out0'], inputs: [gif.id], outputs: [`${base}.${format === 'apng' ? 'png' : format}`], label: `转换 ${gif.name}` })
          return { outputs: [result.files[0].id], summary: `已转换为 ${format.toUpperCase()}（${bytesLabel(gif.size)} → ${bytesLabel(result.files[0].size)}）` }
        }

        const order = validOrder(p.order, images.length).map((i) => images[i])
        const seconds = Math.max(0.5, Number(p.seconds) || 3)
        let [width, height] = String(p.size).split('x').map(Number)
        if (!width || !height) {
          const first = await host.ffmpeg.probe(order[0].id)
          width = even(first.width || 1920)
          height = even(first.height || 1080)
        }
        const bg = /^#[0-9a-f]{6}$/i.test(String(p.background)) ? `0x${String(p.background).slice(1)}` : 'black'

        const args = []
        order.forEach(() => args.push('-loop', '1', '-framerate', '30', '-t', String(seconds), '-i', `$in${args.filter((a) => a === '-i').length}`))
        const parts = order.map((_, i) => {
          const fade = p.fade && seconds >= 1.2 ? `,fade=t=in:st=0:d=0.4,fade=t=out:st=${(seconds - 0.4).toFixed(2)}:d=0.4` : ''
          return `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1,format=yuv420p${fade}[v${i}]`
        })
        const graph = `${parts.join(';')};${order.map((_, i) => `[v${i}]`).join('')}concat=n=${order.length}:v=1:a=0[v]`
        const inputs = order.map((i) => i.id)
        if (audio) {
          args.push('-i', `$in${order.length}`)
          inputs.push(audio.id)
        }
        args.push('-filter_complex', graph, '-map', '[v]')
        if (audio) args.push('-map', `${order.length}:a:0`, '-c:a', 'aac', '-b:a', '192k', '-shortest')
        args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', '30', '-movflags', '+faststart', '-y', '$out0')

        const result = await runMediaFfmpeg({ args, inputs, outputs: ['slideshow.mp4'], label: `合成 ${order.length} 张图片` })
        return { outputs: [result.files[0].id], summary: `已生成 ${formatSpan(order.length * seconds)} 的视频（${width}×${height}）` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'watermark-video',
      name: '视频水印',
      category: 'media',
      icon: 'stamp',
      description: '在画面上拖动放置 Logo 图片或文字水印，可调透明度；中文文字使用内置字体。',
      accept: ['video/*', 'image/png', 'image/webp', 'image/jpeg', '.mkv', '.mov', '.webm'],
      multiple: true,
      keywords: ['watermark', 'logo', 'overlay', 'text', '水印', 'logo', '版权', '台标'],

      async setup(ui) {
        const video = ui.inputs.find((i) => !isImageFile(i))
        const logo = ui.inputs.find(isImageFile)
        if (!video) {
          ui.render({ runDisabled: true, nodes: [{ type: 'alert', tone: 'info', title: '先拖入一个视频', text: '想用图片做水印，就把 Logo 图片一起拖进来；否则可以直接输入文字。' }] })
          return
        }
        livePanel(ui, { ...WATERMARK_DEFAULTS, kind: logo ? 'image' : 'text' }, (state) => ({
          runLabel: '导出视频',
          runDisabled: state.kind === 'image' ? !logo : !String(state.text).trim(),
          nodes: [
            {
              type: 'segmented', bind: 'kind', label: '水印类型',
              options: [{ value: 'image', label: logo ? `图片（${logo.name}）` : '图片（请拖入 Logo）' }, { value: 'text', label: '文字' }],
            },
            { type: 'media', fileId: video.id, meta: 'meta', crop: 'box', height: 300 },
            { type: 'text', variant: 'muted', text: '拖动画面上的方框决定水印的位置和大小：图片按方框宽度等比缩放，文字按方框高度决定字号。' },
            { type: 'input', bind: 'text', label: '水印文字', when: { key: 'kind', equals: 'text' } },
            { type: 'color', bind: 'color', label: '文字颜色', when: { key: 'kind', equals: 'text' } },
            { type: 'slider', bind: 'opacity', label: '不透明度', min: 10, max: 100, step: 5, suffix: '%' },
          ],
        }), ['kind'])
      },

      async run(ctx) {
        const p = withDefaults(ctx.params, WATERMARK_DEFAULTS)
        const videos = ctx.inputs.filter((i) => !isImageFile(i))
        const logo = ctx.inputs.find(isImageFile)
        if (videos.length === 0) throw new Error('请拖入视频')
        const [bx, by, bw, bh] = (Array.isArray(p.box) && p.box.length === 4 ? p.box : WATERMARK_DEFAULTS.box).map((n) => Math.min(1, Math.max(0, Number(n))))
        const alpha = Math.min(1, Math.max(0.05, Number(p.opacity) / 100))
        const outputs = []
        const scratch = []

        try {
          let textRefs = null
          if (p.kind !== 'image') {
            const text = String(p.text || '').trim()
            if (!text) throw new Error('水印文字不能为空')
            // textfile, not text=: nothing in the user's text can break out of the filter syntax.
            textRefs = { font: await cjkFont(scratch), text: await host.fs.writeAll('watermark.txt', text, 'text/plain') }
            scratch.push(textRefs.text.id)
          } else if (!logo) {
            throw new Error('图片水印需要同时拖入一张 Logo 图片')
          }

          for (const [index, video] of videos.entries()) {
            ctx.throwIfAborted()
            let args
            let inputs
            if (p.kind === 'image') {
              const graph =
                `[1:v]format=rgba,colorchannelmixer=aa=${alpha.toFixed(3)}[wm];` +
                // Width from the box, height from the logo's own aspect ratio: never squashed.
                `[wm][0:v]scale2ref=w=trunc(main_w*${bw.toFixed(4)}/2)*2:h=trunc(ow*ih/iw/2)*2[wms][base];` +
                `[base][wms]overlay=x=main_w*${bx.toFixed(4)}:y=main_h*${by.toFixed(4)}:shortest=1:format=auto,format=yuv420p[v]`
              // A still image yields one frame and ends; scale2ref then stops passing the video
              // through and ffmpeg waits forever. Looping the logo and ending with the video fixes it.
              args = ['-i', '$in0', '-loop', '1', '-i', '$in1', '-filter_complex', graph, '-map', '[v]', '-map', '0:a?']
              inputs = [video.id, logo.id]
            } else {
              const color = /^#[0-9a-f]{6}$/i.test(String(p.color)) ? String(p.color) : '#ffffff'
              const filter = `drawtext=fontfile=$in1:textfile=$in2:fontcolor=${color}@${alpha.toFixed(2)}:borderw=2:bordercolor=black@${(alpha * 0.6).toFixed(2)}:fontsize=h*${(bh * 0.8).toFixed(4)}:x=w*${bx.toFixed(4)}:y=h*${by.toFixed(4)}`
              args = ['-i', '$in0', '-vf', `${filter},format=yuv420p`]
              inputs = [video.id, textRefs.font.id, textRefs.text.id]
            }
            // Audio is re-encoded: Opus or Vorbis from a WebM cannot be copied into MP4.
            args.push('-c:v', 'libx264', '-crf', '21', '-preset', 'medium', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', '$out0')
            const result = await runMediaFfmpeg({ args, inputs, outputs: [`${baseName(video.name)}-watermarked.mp4`], label: `添加水印 ${video.name}（${index + 1}/${videos.length}）` })
            outputs.push(result.files[0].id)
          }
        } finally {
          for (const id of scratch) await host.fs.remove(id).catch(() => {})
        }
        return { outputs, summary: `已为 ${outputs.length} 个视频添加水印` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'subtitles',
      name: '字幕工具',
      category: 'media',
      icon: 'type',
      description: 'SRT / VTT / ASS 互转与整体平移时间轴，从视频提取字幕，内嵌软字幕，或把字幕烧录进画面（支持中文）。',
      accept: ['video/*', '.srt', '.vtt', '.ass', '.ssa', '.mkv', '.mov', '.webm', 'text/vtt'],
      multiple: true,
      keywords: ['subtitles', 'srt', 'vtt', 'ass', 'captions', 'burn', 'hardsub', 'softsub', '字幕', '烧录', '内嵌字幕', '提取字幕', '时间轴'],
      params: [
        {
          key: 'mode', type: 'select', label: '操作', default: 'convert',
          options: [
            { value: 'convert', label: '转换格式 / 平移时间轴' },
            { value: 'extract', label: '从视频提取字幕' },
            { value: 'embed', label: '内嵌软字幕（可开关）' },
            { value: 'burn', label: '烧录进画面（硬字幕）' },
          ],
        },
        { key: 'target', type: 'select', label: '输出格式', default: 'srt', options: [{ value: 'srt', label: 'SRT' }, { value: 'vtt', label: 'WebVTT' }, { value: 'ass', label: 'ASS' }], when: { key: 'mode', equals: ['convert', 'extract'] } },
        { key: 'offset', type: 'number', label: '整体平移', default: 0, step: 100, suffix: '毫秒', hint: '正数推后、负数提前。', when: { key: 'mode', equals: 'convert' } },
        { key: 'track', type: 'number', label: '字幕轨道序号', default: 1, min: 1, when: { key: 'mode', equals: 'extract' } },
        { key: 'container', type: 'select', label: '输出容器', default: 'mp4', options: [{ value: 'mp4', label: 'MP4' }, { value: 'mkv', label: 'MKV（保留 ASS 样式）' }], when: { key: 'mode', equals: 'embed' } },
        { key: 'language', type: 'select', label: '字幕语言', default: 'chi', options: [{ value: 'chi', label: '中文' }, { value: 'eng', label: '英文' }, { value: 'jpn', label: '日文' }, { value: 'kor', label: '韩文' }, { value: 'und', label: '未指定' }], when: { key: 'mode', equals: 'embed' } },
        { key: 'fontSize', type: 'slider', label: '字号', min: 12, max: 72, default: 24, when: { key: 'mode', equals: 'burn' } },
        { key: 'margin', type: 'slider', label: '距底部', min: 0, max: 200, default: 24, suffix: 'px', when: { key: 'mode', equals: 'burn' } },
      ],

      async run(ctx) {
        const p = ctx.params
        const videos = ctx.inputs.filter((i) => !isSubtitle(i))
        const subtitles = ctx.inputs.filter(isSubtitle)
        const outputs = []
        const scratch = []

        try {
          if (p.mode === 'convert') {
            if (subtitles.length === 0) throw new Error('请拖入 SRT / VTT / ASS 字幕文件')
            for (const sub of subtitles) {
              const source = await utf8Subtitle(sub, scratch)
              const offset = (Number(p.offset) || 0) / 1000
              const target = String(p.target)
              const result = await runMediaFfmpeg({
                args: [...(offset ? ['-itsoffset', String(offset)] : []), '-i', '$in0', '-c:s', SUBTITLE_CODECS[target], '-y', '$out0'],
                inputs: [source.id], outputs: [`${baseName(sub.name)}${offset ? '-shifted' : ''}.${target}`], label: `转换 ${sub.name}`,
              })
              outputs.push(result.files[0].id)
            }
            return { outputs, summary: `已转换 ${outputs.length} 个字幕文件` }
          }

          if (videos.length === 0) throw new Error('请拖入视频文件')

          if (p.mode === 'extract') {
            const target = String(p.target)
            for (const video of videos) {
              const track = Math.max(1, Math.round(Number(p.track) || 1)) - 1
              const result = await runMediaFfmpeg({
                args: ['-i', '$in0', '-map', `0:s:${track}`, '-c:s', SUBTITLE_CODECS[target], '-y', '$out0'],
                inputs: [video.id], outputs: [`${baseName(video.name)}.${target}`], label: `提取 ${video.name} 的字幕`,
              }).catch((err) => {
                throw new Error(/matches no streams|Stream map/.test(String(err && err.message)) ? `${video.name} 没有第 ${track + 1} 条字幕轨道（烧录在画面里的硬字幕无法提取）` : err)
              })
              outputs.push(result.files[0].id)
            }
            return { outputs, summary: `已提取 ${outputs.length} 个字幕文件` }
          }

          if (subtitles.length === 0) throw new Error('请同时拖入视频和字幕文件')
          const [video] = videos
          const source = await utf8Subtitle(subtitles[0], scratch)

          if (p.mode === 'embed') {
            const mkv = p.container === 'mkv'
            const result = await runMediaFfmpeg({
              args: [
                '-i', '$in0', '-i', '$in1', '-map', '0:v', '-map', '0:a?', '-map', '1:0', '-c:v', 'copy', '-c:a', 'copy',
                '-c:s', mkv ? (/\.(ass|ssa)$/i.test(subtitles[0].name) ? 'ass' : 'srt') : 'mov_text',
                '-metadata:s:s:0', `language=${p.language}`, '-disposition:s:0', 'default', '-y', '$out0',
              ],
              inputs: [video.id, source.id], outputs: [`${baseName(video.name)}-subtitled.${mkv ? 'mkv' : 'mp4'}`], label: '内嵌字幕',
            })
            return { outputs: [result.files[0].id], summary: '已内嵌字幕（播放器里可以开关）' }
          }

          // Burn: libass needs a font it can find by file, since there is no system font here.
          const font = await cjkFont(scratch)
          const style = `FontName=Noto Sans SC,FontSize=${Math.round(Number(p.fontSize) || 24)},MarginV=${Math.round(Number(p.margin) || 24)},Outline=2,Shadow=0`
          const result = await runMediaFfmpeg({
            args: ['-i', '$in0', '-vf', `subtitles=$in1:fontsdir=/:force_style='${style}'`, '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', '$out0'],
            inputs: [video.id, source.id, font.id], outputs: [`${baseName(video.name)}-hardsub.mp4`], label: '烧录字幕',
          })
          return { outputs: [result.files[0].id], summary: '已把字幕烧录进画面' }
        } finally {
          for (const id of scratch) await host.fs.remove(id).catch(() => {})
        }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'inspect-media',
      name: '媒体信息',
      category: 'media',
      icon: 'info',
      description: '读取时长、分辨率、编码格式与码率。',
      accept: ['video/*', 'audio/*', '.mkv', '.mov', '.avi', '.webm', '.m4a', '.flac'],
      multiple: true,
      keywords: ['info', 'probe', 'metadata', '信息', '元数据', '编码'],

      async run(ctx) {
        const report = []
        await eachInput(ctx, async (input) => {
          const probe = await host.ffmpeg.probe(input.id)
          report.push({
            file: input.name,
            bytes: input.size,
            durationSeconds: probe.durationSeconds,
            width: probe.width,
            height: probe.height,
            videoCodec: probe.videoCodec,
            audioCodec: probe.audioCodec,
            raw: probe.log,
          })
        })

        const out = await host.fs.writeAll('media-info.json', JSON.stringify(report, null, 2), 'application/json')
        return { outputs: [out.id], summary: `已分析 ${report.length} 个媒体文件` }
      },
    },
  ],
})

/* ========================================================================== */
/* Panels                                                                     */
/* ========================================================================== */

/**
 * One defaults table per panel tool, used by both `setup` (initial state) and
 * `run` (missing keys). A setup tool has no manifest params for the host to
 * default, so without this a stored state from an older version - or any caller
 * that skips the panel - would reach ffmpeg as `volume=NaN`.
 */
const COMPRESS_DEFAULTS = { mode: 'quality', level: '28', targetMB: 10, downscale: true, meta: [] }
const TRIM_DEFAULTS = { range: [], copy: true, format: 'same' }
const AUDIO_EDIT_DEFAULTS = { range: [], volume: 100, normalize: false, fadeIn: 0, fadeOut: 0, speed: 100, pitch: 0, denoise: false, removeSilence: false, channels: 'keep', format: 'mp3', meta: [] }
const VIDEO_EDIT_DEFAULTS = { range: [], meta: [], crop: [], cropOn: false, aspectPreset: 'free', cropAspect: 0, rotate: '0', flipH: false, flipV: false, brightness: 0, contrast: 100, saturation: 100, hue: 0, speed: 100, mute: false }
const GIF_DEFAULTS = { range: [], meta: [], crop: [], cropOn: false, aspectPreset: 'free', cropAspect: 0, format: 'gif', fps: 12, width: 480, loop: true }
const FRAMES_DEFAULTS = { mode: 'marked', markers: [], range: [], meta: [], interval: 5, count: 10, width: 0, format: 'jpg' }

const ASPECTS = [
  { value: 'free', label: '自由', ratio: 0 },
  { value: '16:9', label: '16:9', ratio: 16 / 9 },
  { value: '9:16', label: '9:16', ratio: 9 / 16 },
  { value: '1:1', label: '1:1', ratio: 1 },
  { value: '4:3', label: '4:3', ratio: 4 / 3 },
]

/**
 * Renders an empty-state alert and disables the run button until the tool has
 * at least `min` inputs. Returns whether setup should continue.
 */
function requireInputs(ui, min, title, text) {
  if (ui.inputs.length >= min) return true
  ui.render({ runDisabled: true, nodes: [{ type: 'alert', tone: 'info', title, text }] })
  return false
}

/** State that describes particular input files rather than a preference. */
const PER_FILE = ['range', 'meta', 'markers', 'order']

/**
 * A panel that is a pure function of state.
 *
 * `defaults` fill in keys the host has no value for yet (values from a previous
 * open of the same tool are kept). The tree is rebuilt when one of `keys`
 * changes - derived text like output sizes - and not on every slider tick of an
 * unrelated control, since the host already reflects bound values itself.
 */
function livePanel(ui, defaults, build, keys, hooks = {}) {
  // The session re-opens whenever the inputs change. Settings carry over, but a
  // time range, markers or clip order describe the previous files and must not.
  const files = ui.inputs.map((input) => input.id).join('|')
  const sameFiles = ui.state._files === files
  const state = { _files: files }
  for (const [key, value] of Object.entries(defaults)) {
    const existing = ui.state[key]
    const reusable = existing !== undefined && typeof existing === typeof value && Array.isArray(existing) === Array.isArray(value)
    state[key] = reusable && (sameFiles || !PER_FILE.includes(key)) ? existing : value
  }
  ui.render({ state, ...build(withDefaults(state, defaults)) })

  ui.on('change', (key, value, current) => {
    hooks.onChange?.(key, value, current)
    if (!keys || keys.includes(key)) ui.render(build(withDefaults(ui.state, defaults)))
  })
  ui.on('action', (name, _value, current) => {
    hooks.onAction?.(name, current)
    ui.render(build(withDefaults(ui.state, defaults)))
  })
}

/**
 * `state` over `defaults`, coerced to each default's type. Numbers and strings
 * convert (a caller passing `rotate: 90` means '90'); a value that cannot be the
 * right kind at all - `NaN`, an object where a list belongs - is dropped.
 */
function withDefaults(state, defaults) {
  const out = { ...defaults }
  for (const [key, value] of Object.entries(state || {})) {
    if (value === undefined || value === null) continue
    const fallback = defaults[key]
    if (fallback === undefined) out[key] = value
    else if (Array.isArray(fallback)) {
      if (Array.isArray(value)) out[key] = value
    } else if (typeof fallback === 'number') {
      if (value !== '' && Number.isFinite(Number(value))) out[key] = Number(value)
    } else if (typeof fallback === 'string') {
      if (typeof value === 'string' || typeof value === 'number') out[key] = String(value)
    } else if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') out[key] = value
    }
  }
  return out
}

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

const EFFECT_LABELS = { blurpad: '补边', reverse: '倒放', fps: '转换帧率', stabilize: '防抖', denoise: '降噪', metadata: '清除元数据' }

const SPLIT_DEFAULTS = { mode: 'marks', markers: [], meta: [], length: 30, format: 'mp3', range: [], fade: true }

/** Cut positions strictly inside the file, from markers or a fixed segment length. */
function cutPoints(state, duration) {
  if (!duration) return []
  if (state.mode === 'length') {
    const length = Math.max(1, Number(state.length) || 30)
    const cuts = []
    for (let t = length; t < duration - 0.05; t += length) cuts.push(t)
    return cuts
  }
  return [...new Set((Array.isArray(state.markers) ? state.markers : []).filter((t) => t > 0.05 && t < duration - 0.05))].sort((a, b) => a - b)
}

const SLIDESHOW_DEFAULTS = { order: [], seconds: 3, size: 'first', fade: true, background: '#000000', gifFormat: 'mp4', loops: 1 }

const WATERMARK_DEFAULTS = { kind: 'text', box: [0.68, 0.05, 0.28, 0.08], text: '© OmniTool', color: '#ffffff', opacity: 80, meta: [] }

function isImageFile(input) {
  return /^image\//.test(input.type || '') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(input.name)
}

function isSubtitle(input) {
  return /\.(srt|vtt|ass|ssa)$/i.test(input.name) || /^text\/(vtt|x-ssa|x-subrip)/.test(input.type || '')
}

const SUBTITLE_CODECS = { srt: 'srt', vtt: 'webvtt', ass: 'ass' }

/**
 * Subtitle files from Chinese sources are often GBK. ffmpeg assumes UTF-8, so
 * anything that is not valid UTF-8 is re-encoded into a scratch copy first.
 */
async function utf8Subtitle(input, scratch) {
  const bytes = await host.fs.readAll(input.id)
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return input
  } catch {
    const text = new TextDecoder('gbk').decode(bytes)
    const copy = await host.fs.writeAll(`utf8-${input.name}`, text, 'text/plain')
    scratch.push(copy.id)
    return copy
  }
}

/**
 * The bundled CJK font as a workspace file ffmpeg can mount, for drawtext and
 * libass. Recorded in `scratch` so the caller removes it afterwards.
 */
async function cjkFont(scratch) {
  const { exports: fonts, assets } = await loadDependency('cjk-font')
  const name = 'NotoSansSC-Regular.ttf'
  if (!fonts[name]?.available || !assets[name] || assets[name].byteLength < 1024) {
    throw new Error('内置中文字体未打包（构建时需要联网运行一次 pnpm vendor），暂时无法渲染文字')
  }
  const file = await host.fs.writeAll(name, new Uint8Array(assets[name]), 'font/ttf')
  scratch.push(file.id)
  return file
}

/* ------------------------------- spectrogram ------------------------------ */

/**
 * Spectrograms are computed here rather than with ffmpeg's showspectrumpic.
 * That filter transforms the whole recording in wasm - over five minutes for
 * ten minutes of audio - while the picture only has one column per pixel. So
 * ffmpeg just decodes to 16-bit mono PCM, and each column averages a few
 * Hann-windowed FFTs (fft.js) spread across the stretch of audio it covers.
 */
const PCM_RATES = [44100, 32000, 22050, 16000, 11025, 8000]
/** Decoded PCM is written to the workspace; very long recordings get a lower rate to stay within this. */
const PCM_BYTE_LIMIT = 400 * 1024 * 1024

async function drawSpectrogram(ctx, input, p, index) {
  const { exports: FFT } = await loadDependency('fft')
  const width = Math.round(Number(p.width) || 1600)
  const height = Math.round(Number(p.height) || 400)
  const wanted = Number(p.rate) || 22050
  const duration = (await host.ffmpeg.probe(input.id)).durationSeconds || 0
  const rate = PCM_RATES.find((r) => r <= wanted && (!duration || duration * r * 2 <= PCM_BYTE_LIMIT)) ?? 8000
  const { files } = await runMediaFfmpeg({
    args: ['-i', '$in0', '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-c:a', 'pcm_s16le', '-y', '$out0'],
    inputs: [input.id], outputs: ['spectrum.pcm'], label: `解码 ${input.name}（${index + 1}/${ctx.inputs.length}）`,
  })
  const pcm = files[0]
  try {
    const totalSamples = Math.floor(pcm.size / 2)
    if (totalSamples === 0) throw new Error(`${input.name} 解码后没有音频采样`)
    const matrix = await spectrogramMatrix({
      FFT, read: pcmReader(pcm.id, totalSamples), totalSamples, rate, width, height, scale: p.fscale === 'log' ? 'log' : 'lin',
      onProgress: (f) => ctx.progress((index + f) / ctx.inputs.length, `计算频谱 ${input.name}`),
    })
    const png = await paintSpectrogram(matrix, { width, height, rate, duration: totalSamples / rate, scale: p.fscale === 'log' ? 'log' : 'lin' })
    const out = await host.fs.writeAll(`${baseName(input.name)}-spectrum.png`, png, 'image/png')
    const note = rate < wanted ? `${input.name} 较长，频率上限降为 ${formatHz(rate / 2)}` : ''
    return { id: out.id, note }
  } finally {
    await host.fs.remove(pcm.id).catch(() => {})
  }
}

/**
 * Reads samples `[offset, offset + length)` of 16-bit PCM into `out` as floats,
 * zero outside the file. Requests move forward in time, so it keeps one block
 * (about 4 MB) and reads the next only when a window leaves it - a two-hour
 * recording never has to fit in memory.
 */
function pcmReader(id, totalSamples) {
  const BLOCK = 1 << 21
  let start = 0
  let block = null
  return async function read(offset, length, out) {
    out.fill(0)
    const from = Math.max(0, offset)
    const to = Math.min(totalSamples, offset + length)
    if (from >= to) return
    if (!block || from < start || to > start + block.length) {
      const count = Math.min(totalSamples - from, Math.max(BLOCK, to - from))
      // Copy: an Int16Array view needs an even byte offset, which a transferred slice may not have.
      const bytes = (await host.fs.read(id, from * 2, count * 2)).slice()
      block = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1)
      start = from
    }
    for (let i = from; i < to; i++) out[i - offset] = block[i - start] / 32768
  }
}

/**
 * Power spectrum per pixel as dBFS, `[height × width]`, top row = highest
 * frequency. The FFT size follows the image height (two bins per row or more);
 * each row takes the strongest bin in its frequency band, so narrow tones are
 * not lost between rows.
 */
async function spectrogramMatrix({ FFT, read, totalSamples, rate, width, height, scale, onProgress = () => {} }) {
  const size = Math.min(8192, Math.max(512, 2 ** Math.ceil(Math.log2(height * 2))))
  const bins = size / 2
  const fft = new FFT(size)
  const hann = new Float64Array(size)
  let windowSum = 0
  for (let i = 0; i < size; i++) windowSum += hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1))
  // A full-scale sine then reads 0 dBFS.
  const reference = (windowSum / 2) ** 2
  const frame = new Float64Array(size)
  const spectrum = new Float64Array(size * 2)
  const power = new Float64Array(bins)

  const nyquist = rate / 2
  const minFreq = Math.min(20, nyquist / 100)
  const edge = (t) => (scale === 'log' ? minFreq * (nyquist / minFreq) ** t : t * nyquist)
  const rowLo = new Int32Array(height)
  const rowHi = new Int32Array(height)
  for (let y = 0; y < height; y++) {
    const low = edge((height - 1 - y) / height)
    const high = edge((height - y) / height)
    rowLo[y] = Math.min(bins - 1, Math.floor((low / nyquist) * bins))
    rowHi[y] = Math.min(bins - 1, Math.max(rowLo[y], Math.ceil((high / nyquist) * bins) - 1))
  }

  const db = new Float32Array(width * height)
  let max = -Infinity
  for (let x = 0; x < width; x++) {
    const from = (x * totalSamples) / width
    const span = totalSamples / width
    const windows = Math.min(6, Math.max(1, Math.ceil(span / size)))
    power.fill(0)
    for (let k = 0; k < windows; k++) {
      const centre = from + (span * (k + 0.5)) / windows
      await read(Math.round(centre - size / 2), size, frame)
      for (let i = 0; i < size; i++) frame[i] *= hann[i]
      fft.realTransform(spectrum, frame)
      for (let b = 0; b < bins; b++) power[b] += spectrum[2 * b] ** 2 + spectrum[2 * b + 1] ** 2
    }
    for (let y = 0; y < height; y++) {
      let peak = 0
      for (let b = rowLo[y]; b <= rowHi[y]; b++) if (power[b] > peak) peak = power[b]
      const value = 10 * Math.log10(peak / windows / reference + 1e-12)
      db[y * width + x] = value
      if (value > max) max = value
    }
    if ((x & 63) === 0) onProgress(x / width)
  }
  onProgress(1)
  return { db, max, width, height, fftSize: size }
}

/** Inferno-like colour stops: silence is near-black, the loudest parts pale yellow. */
const SPECTRUM_STOPS = [[0, 0, 0, 4], [0.25, 87, 16, 110], [0.5, 188, 55, 84], [0.75, 249, 142, 9], [1, 252, 255, 164]]
const SPECTRUM_RANGE_DB = 90

function spectrumColour(t) {
  const i = Math.min(SPECTRUM_STOPS.length - 2, Math.floor(t * (SPECTRUM_STOPS.length - 1)))
  const [t0, r0, g0, b0] = SPECTRUM_STOPS[i]
  const [t1, r1, g1, b1] = SPECTRUM_STOPS[i + 1]
  const f = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)))
  return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f]
}

/** The matrix as a PNG with time and frequency axes and a dB colour bar. */
async function paintSpectrogram({ db, max }, { width, height, rate, duration, scale }) {
  const left = 64
  const right = 76
  const top = 20
  const bottom = 40
  const canvas = new OffscreenCanvas(width + left + right, height + top + bottom)
  const g = canvas.getContext('2d')
  g.fillStyle = '#0b0b10'
  g.fillRect(0, 0, canvas.width, canvas.height)

  const ceiling = Math.min(0, Math.ceil(max))
  const floor = ceiling - SPECTRUM_RANGE_DB
  const lut = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) lut.set(spectrumColour(i / 255), i * 3)
  const image = g.createImageData(width, height)
  for (let i = 0; i < db.length; i++) {
    const level = Math.max(0, Math.min(255, Math.round(((db[i] - floor) / SPECTRUM_RANGE_DB) * 255)))
    image.data[i * 4] = lut[level * 3]
    image.data[i * 4 + 1] = lut[level * 3 + 1]
    image.data[i * 4 + 2] = lut[level * 3 + 2]
    image.data[i * 4 + 3] = 255
  }
  g.putImageData(image, left, top)

  g.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif'
  g.fillStyle = '#d4d4d8'
  g.strokeStyle = 'rgba(212, 212, 216, 0.5)'
  g.lineWidth = 1

  // Time axis.
  g.textAlign = 'center'
  g.textBaseline = 'top'
  const timeStep = niceStep(duration, Math.max(2, Math.floor(width / 110)), [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200])
  for (let t = 0; t <= duration + 1e-6; t += timeStep) {
    const x = left + Math.round((t / duration) * width)
    g.beginPath()
    g.moveTo(x + 0.5, top + height)
    g.lineTo(x + 0.5, top + height + 5)
    g.stroke()
    g.fillText(formatClock(t, timeStep), x, top + height + 8)
  }

  // Frequency axis.
  g.textAlign = 'right'
  g.textBaseline = 'middle'
  const nyquist = rate / 2
  const minFreq = Math.min(20, nyquist / 100)
  const ticks = scale === 'log'
    ? [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter((f) => f >= minFreq && f <= nyquist)
    : (() => {
        const step = niceStep(nyquist, Math.max(2, Math.floor(height / 45)), [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000])
        const list = []
        for (let f = 0; f <= nyquist + 1e-6; f += step) list.push(f)
        return list
      })()
  for (const f of ticks) {
    const t = scale === 'log' ? Math.log(f / minFreq) / Math.log(nyquist / minFreq) : f / nyquist
    const y = top + height - Math.round(t * height)
    g.beginPath()
    g.moveTo(left - 5, y + 0.5)
    g.lineTo(left, y + 0.5)
    g.stroke()
    g.fillText(formatHz(f), left - 8, Math.min(top + height - 6, Math.max(top + 6, y)))
  }

  // Colour bar.
  const barX = left + width + 14
  const gradient = g.createLinearGradient(0, top + height, 0, top)
  for (let i = 0; i <= 10; i++) {
    const [r, gr, b] = spectrumColour(i / 10)
    gradient.addColorStop(i / 10, `rgb(${r | 0}, ${gr | 0}, ${b | 0})`)
  }
  g.fillStyle = gradient
  g.fillRect(barX, top, 12, height)
  g.fillStyle = '#d4d4d8'
  g.textAlign = 'left'
  for (let i = 0; i <= 3; i++) {
    const y = top + Math.round((i / 3) * height)
    g.fillText(`${ceiling - (SPECTRUM_RANGE_DB * i) / 3} dB`, barX + 18, Math.min(top + height - 6, Math.max(top + 6, y)))
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

/** The smallest step from `candidates` that keeps the tick count at or below `maxTicks`. */
function niceStep(range, maxTicks, candidates) {
  return candidates.find((step) => range / step <= maxTicks) ?? candidates[candidates.length - 1]
}

function formatClock(seconds, step) {
  const whole = Math.floor(seconds + 1e-6)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const frac = step < 1 ? (seconds - whole).toFixed(1).slice(1) : ''
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}${frac}`
}

function formatHz(f) {
  return f >= 1000 ? `${Number((f / 1000).toFixed(1))} kHz` : `${Math.round(f)} Hz`
}

async function eachInput(ctx, fn) {
  if (ctx.inputs.length === 0) throw new Error('请先拖入至少一个文件')
  for (let i = 0; i < ctx.inputs.length; i++) {
    ctx.throwIfAborted()
    await fn(ctx.inputs[i], i)
  }
  ctx.progress(1)
}

/**
 * Whether a file has an audio stream. Tools that read audio check first:
 * otherwise a video-only file (screen recordings, many WebM clips) fails deep
 * inside FFmpeg with "Stream specifier ':a:0' matches no streams".
 */
async function hasAudio(input) {
  return !!(await host.ffmpeg.probe(input.id)).audioCodec
}

async function requireAudio(input, purpose) {
  if (!(await hasAudio(input))) throw new Error(`${input.name} 没有音轨（只有画面），无法${purpose}`)
}

function noAudioMessage(names, purpose) {
  return names.length === 1 ? `${names[0]} 没有音轨（只有画面），无法${purpose}` : `所选文件都没有音轨（只有画面），无法${purpose}`
}

function skippedNote(names) {
  return names.length ? `（已跳过没有音轨的 ${names.join('、')}）` : ''
}

function isAudio(input) {
  return /^audio\//.test(input.type || '') || /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i.test(input.name)
}

/** A permutation of 0..n-1, or the natural order if `value` is not one. */
function validOrder(value, n) {
  const order = Array.isArray(value) ? value : []
  const ok = order.length === n && new Set(order).size === n && order.every((i) => Number.isInteger(i) && i >= 0 && i < n)
  return ok ? order : Array.from({ length: n }, (_, i) => i)
}

/**
 * Crop from fractions of the source frame. Expressions keep one selection valid
 * for any resolution; dimensions are rounded down to even numbers because
 * yuv420p (and so H.264) cannot encode odd sizes.
 */
function cropFilter([x, y, w, h]) {
  const f = (n) => Math.min(1, Math.max(0, Number(n))).toFixed(4)
  return `crop=trunc(iw*${f(w)}/2)*2:trunc(ih*${f(h)}/2)*2:trunc(iw*${f(x)}):trunc(ih*${f(y)})`
}

/** Output frame size after an optional fractional crop and rotation. */
function outputSize(width, height, crop, rotate) {
  let w = width
  let h = height
  if (Array.isArray(crop) && crop.length === 4) {
    w = Math.floor((width * crop[2]) / 2) * 2
    h = Math.floor((height * crop[3]) / 2) * 2
  }
  return Number(rotate) % 180 === 0 ? { width: w, height: h } : { width: h, height: w }
}

/** atempo only accepts 0.5–2.0, so larger changes chain stages. */
function tempoChain(speed) {
  if (!speed || speed === 1) return []
  const stages = []
  let remaining = speed
  while (remaining > 2) {
    stages.push('atempo=2.0')
    remaining /= 2
  }
  while (remaining < 0.5) {
    stages.push('atempo=0.5')
    remaining *= 2
  }
  stages.push(`atempo=${remaining.toFixed(4)}`)
  return stages
}

/** Video bitrate that fits `targetMB` over `duration` seconds after 128 kbps of audio. */
function targetVideoKbps(targetMB, duration) {
  return Math.max(80, Math.round((targetMB * 8192) / duration - 128))
}

function even(n) {
  return Math.max(2, Math.floor(n / 2) * 2)
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, '')
}

function extensionOf(name) {
  const match = /(\.[^.]+)$/.exec(name)
  return match ? match[1] : '.mp4'
}

/** "00:01:23.5", "1:23" or "83.5" → seconds. */
function parseClock(text) {
  const parts = text.trim().split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return 0
  return parts.reduce((total, n) => total * 60 + n, 0)
}

/** 83.5 -> "01m23s", safe for filenames. */
function clockName(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`
}

/** 83.25 -> "01m23s250", so frames marked within the same second stay distinct. */
function stampName(seconds) {
  return `${clockName(seconds)}${String(Math.round((seconds % 1) * 1000)).padStart(3, '0')}`
}

function formatSpan(seconds) {
  const safe = Math.max(0, Number(seconds) || 0)
  const m = Math.floor(safe / 60)
  const s = (safe % 60).toFixed(2).padStart(5, '0')
  return `${String(m).padStart(2, '0')}:${s}`
}

function bytesLabel(value) {
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KB', 'MB', 'GB']
  let n = value / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
}

function deltaLabel(before, after) {
  if (before <= 0) return '-'
  const pct = ((after - before) / before) * 100
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`
}

/** All built-in H.264/HEVC exports use 4:2:0; preserve odd edge pixels by padding. */
function runMediaFfmpeg(options) {
  const args = [...options.args]
  const codec = args[args.indexOf('-c:v') + 1]
  if (codec === 'libx264' || codec === 'libx265') {
    const pad = 'pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p'
    const complex = args.indexOf('-filter_complex')
    const simple = args.indexOf('-vf')
    if (complex !== -1) {
      // Built-in complex graphs expose their final video as [v].
      args[complex + 1] += `;[v]${pad}[even]`
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '-map' && args[i + 1] === '[v]') args[i + 1] = '[even]'
      }
    } else if (simple !== -1) {
      args[simple + 1] += `,${pad}`
    } else {
      args.splice(args.length - 1, 0, '-vf', pad)
    }
  }
  return host.ffmpeg.run({ ...options, args })
}
