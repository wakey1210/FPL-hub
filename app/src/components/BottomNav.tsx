import { NavLink } from 'react-router-dom'

const TABS = [
  { to: '/', label: 'Status', icon: '●', end: true },
  { to: '/pick-team', label: 'Pick Team', icon: '⚽' },
  { to: '/transfers', label: 'Transfers', icon: '⇄' },
  { to: '/planner', label: 'Planner', icon: '📅' },
  { to: '/more', label: 'More', icon: '⋯' },
]

export function BottomNav() {
  return (
    <nav className="fixed bottom-0 inset-x-0 z-20 bg-[#37003c] border-t border-white/10 pb-[env(safe-area-inset-bottom)]">
      <ul className="flex justify-around">
        {TABS.map((tab) => (
          <li key={tab.to} className="flex-1">
            <NavLink
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                `flex flex-col items-center gap-0.5 py-2 text-xs font-medium ${
                  isActive ? 'text-[#00ff87]' : 'text-white/60'
                }`
              }
            >
              <span className="text-lg leading-none">{tab.icon}</span>
              {tab.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
