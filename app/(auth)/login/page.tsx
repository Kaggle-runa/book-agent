// page.tsx
'use client'

import { Suspense } from 'react'
import LoginForm from './LoginForm'

export default function LoginPageWrapper() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <LoginForm />
    </Suspense>
  )
}