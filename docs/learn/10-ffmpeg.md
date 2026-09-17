---
title: 调用 FFmpeg
titleEn: Calling FFmpeg
chapter: 宿主能力
sample: none
---

音视频处理不用自己写解码器：申请 `ffmpeg` 能力，宿主会在本机运行 FFmpeg（WebAssembly 版），
你只需要给出命令行参数。

```js
const { files } = await ctx.host.ffmpeg.run({
  args: ['-i', '$in0', '-vn', '-c:a', 'libmp3lame', '$out0'],
  inputs: [ctx.inputs[0].id],   // $in0、$in1 … 对应这里的文件
  outputs: ['audio.mp3'],        // $out0、$out1 … 对应这里的文件名
  label: '提取音轨',             // 显示在任务队列里
})
```

- 输出文件直接落进工作区，**不经过你的内存**，几个 GB 的视频也没问题；
- 线程数由宿主管理，你不要写 `-threads`；
- `ctx.host.ffmpeg.probe(id)` 返回时长、分辨率、音视频编码——在使用某个流之前先确认它存在。
  比如一个只有画面的录屏没有音轨，直接用 `[0:a]` 会让 FFmpeg 报出晦涩的错误；先 probe 再给出人话提示。

FFmpeg 首次使用时加载（约 32 MB），之后缓存。

## 不需要输入的生成器

FFmpeg 的 `lavfi` 虚拟输入可以凭空生成音视频，这正适合教程：下面的工具用 `sine` 生成一段音调，
不需要你提供任何文件。

## 动手试试

1. 运行它，在结果里播放生成的音频。
2. 把频率做成滑块参数（200–2000 Hz），时长做成数字参数（1–10 秒）。
3. 再输出一张这段音频的波形图：第二个输出文件，用 `-filter_complex "showwavespic=s=800x200"` 和 `-frames:v 1`。
   提示：可以在同一次 `run` 里写两个输出，也可以把第一次的输出文件 id 作为第二次的 `inputs`。

```js starter
definePlugin({
  id: 'learn.ffmpeg',
  name: '音调生成器',
  version: '1.0.0',
  capabilities: ['ffmpeg'],
  tools: [
    {
      id: 'tone',
      name: '生成音调',
      category: 'media',
      input: 'none',
      async run(ctx) {
        const { files } = await ctx.host.ffmpeg.run({
          args: ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', '-b:a', '128k', '-y', '$out0'],
          inputs: [],
          outputs: ['tone-440.mp3'],
          label: '生成 440 Hz 音调',
        })
        return { outputs: files.map((f) => f.id), summary: '已生成 2 秒的 440 Hz 音调' }
      },
    },
  ],
})
```

```js solution
definePlugin({
  id: 'learn.ffmpeg',
  name: '音调生成器',
  version: '1.0.0',
  capabilities: ['ffmpeg'],
  tools: [
    {
      id: 'tone',
      name: '生成音调',
      category: 'media',
      input: 'none',
      params: [
        { key: 'frequency', type: 'slider', label: '频率', min: 200, max: 2000, step: 10, default: 440, suffix: ' Hz' },
        { key: 'seconds', type: 'number', label: '时长', min: 1, max: 10, default: 2, suffix: '秒' },
      ],
      async run(ctx) {
        const frequency = Math.round(Number(ctx.params.frequency))
        const seconds = Math.min(10, Math.max(1, Number(ctx.params.seconds)))
        const audio = await ctx.host.ffmpeg.run({
          args: ['-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '128k', '-y', '$out0'],
          inputs: [],
          outputs: [`tone-${frequency}.mp3`],
          label: `生成 ${frequency} Hz 音调`,
        })
        ctx.progress(0.5, '绘制波形')
        const wave = await ctx.host.ffmpeg.run({
          args: ['-i', '$in0', '-filter_complex', 'showwavespic=s=800x200', '-frames:v', '1', '-y', '$out0'],
          inputs: [audio.files[0].id],
          outputs: [`tone-${frequency}.png`],
          label: '绘制波形',
        })
        return { outputs: [audio.files[0].id, wave.files[0].id], summary: `已生成 ${seconds} 秒的 ${frequency} Hz 音调与波形图` }
      },
    },
  ],
})
```
