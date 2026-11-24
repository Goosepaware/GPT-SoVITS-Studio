import { useEffect, useState } from 'react'
import { LogOut, PanelBottomClose } from 'lucide-react'
import { Modal } from './Modal'

/** Shown when the window close button is pressed and config.closeAction === 'ask'. */
export function CloseDialog(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)

  useEffect(
    () =>
      window.api.window.onCloseRequest(() => {
        setRemember(false)
        setOpen(true)
      }),
    []
  )

  const choose = (choice: 'tray' | 'quit'): void => {
    setOpen(false)
    // Let the fade-out finish before the window is hidden (rAF pauses when hidden).
    if (choice === 'tray') setTimeout(() => window.api.window.closeChoice(choice, remember), 220)
    else window.api.window.closeChoice(choice, remember)
  }

  return (
    <Modal
      open={open}
      title="关闭 GPT-SoVITS-Studio"
      subtitle="最小化后 MCP 服务和已加载的模型继续保留，可从托盘右键卸载显存或退出。"
      onClose={() => setOpen(false)}
      width={440}
      footer={
        <>
          <label className="close-remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            记住我的选择（可在设置中修改）
          </label>
          <div className="close-actions">
            <button className="btn ghost" onClick={() => choose('quit')}>
              <LogOut size={15} />
              直接退出
            </button>
            <button className="btn primary" autoFocus onClick={() => choose('tray')}>
              <PanelBottomClose size={15} />
              最小化到托盘
            </button>
          </div>
        </>
      }
    >
      <div className="modal-note">直接退出会先卸载模型、释放显存，并停止 MCP 服务。</div>
    </Modal>
  )
}
