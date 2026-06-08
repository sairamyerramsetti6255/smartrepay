import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { DemoDataBanner } from './DemoDataBanner'

export function Layout() {
  return (
    <div className="min-h-screen bg-[var(--bg-app)]">
      <Sidebar />
      <TopBar />
      <main className="ml-[248px] pt-14 min-h-screen">
        <div className="p-10 max-w-[1160px]">
          <DemoDataBanner />
          <div className="page-enter">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  )
}
