import { useEffect, useState } from 'react'
import { AudioWaveform, Minus, Square, X } from 'lucide-react'

export function TitleBar(): JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => window.api.window.onMaximized(setMaximized), [])

  return (
    <header className="titlebar" onDoubleClick={() => window.api.window.toggleMaximize()}>
      <div className="titlebar-brand">
        <div className="brand-mark">
          <AudioWaveform size={17} strokeWidth={2.4} />
        </div>
        <div className="brand-copy">
          <span className="brand-name">GPT-SoVITS-Studio</span>
          <span className="brand-tag">v5turbo</span>
        </div>
      </div>
      <div className="titlebar-drag" />
      <div className="window-controls" onDoubleClick={(event) => event.stopPropagation()}>
        <button className="window-btn" title="最小化" onClick={() => window.api.window.minimize()}>
          <Minus size={15} />
        </button>
        <button className="window-btn" title={maximized ? '还原' : '最大化'} onClick={() => window.api.window.toggleMaximize()}>
          <Square size={12} />
        </button>
        <button className="window-btn close" title="关闭" onClick={() => window.api.window.close()}>
          <X size={15} />
        </button>
      </div>
    </header>
  )
}
