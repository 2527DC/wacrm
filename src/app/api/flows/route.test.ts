import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST } from './route'
import { getCurrentAccount, UnauthorizedError } from '@/lib/auth/account'

// 1. Hoisted mock state for supabaseAdmin
const h = vi.hoisted(() => ({
  state: {
    inserted: [] as { table: string; payload: any }[],
  },
}))

// Mock supabaseAdmin from admin-client
vi.mock('@/lib/flows/admin-client', () => {
  const { state } = h
  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        const ops = {
          table,
          payload: null as any,
        }
        const b: any = {
          insert: (payload: any) => {
            ops.payload = payload
            state.inserted.push({ table, payload })
            return b
          },
          select: () => b,
          single: () =>
            Promise.resolve({
              data: { id: 'mock-flow-uuid', ...ops.payload },
              error: null,
            }),
          delete: () => b,
          eq: () => b,
          then: (onF: any) => {
            const res =
              table === 'flows'
                ? { data: { id: 'mock-flow-uuid', ...ops.payload }, error: null }
                : { error: null }
            return Promise.resolve(res).then(onF)
          },
        }
        return b
      },
    }),
  }
})

// Mock auth account helpers
vi.mock('@/lib/auth/account', () => {
  class UnauthorizedError extends Error {
    readonly status = 401
    constructor(message = 'Unauthorized') {
      super(message)
      this.name = 'UnauthorizedError'
    }
  }
  class ForbiddenError extends Error {
    readonly status = 403
    constructor(message = 'Forbidden') {
      super(message)
      this.name = 'ForbiddenError'
    }
  }
  return {
    getCurrentAccount: vi.fn(),
    UnauthorizedError,
    ForbiddenError,
    toErrorResponse: vi.fn((err: any) => {
      const status = err.status || 500
      const message = err.message || 'Internal server error'
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  }
})

const mockSupabase = {
  from: () => {
    const b: any = {
      select: () => b,
      order: () => b,
      then: (onF: any) =>
        Promise.resolve({
          data: [{ id: 'flow-1', name: 'Existing Flow' }],
          error: null,
        }).then(onF),
    }
    return b
  },
}

beforeEach(() => {
  h.state.inserted = []
  vi.clearAllMocks()

  vi.mocked(getCurrentAccount).mockResolvedValue({
    userId: 'test-user-uuid',
    accountId: 'test-account-uuid',
    role: 'agent',
    account: { id: 'test-account-uuid', name: 'Test Account' },
    supabase: mockSupabase as any,
  })
})

describe('GET /api/flows', () => {
  it('successfully returns list of flows for the authenticated user', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.flows).toHaveLength(1)
    expect(body.flows[0].name).toBe('Existing Flow')
  })

  it('returns unauthorized when no session exists', async () => {
    vi.mocked(getCurrentAccount).mockRejectedValue(new UnauthorizedError())
    const res = await GET()
    expect(res.status).toBe(401)
  })
})

describe('POST /api/flows', () => {
  it('stamps user_id and account_id when creating a new flow', async () => {
    const req = new Request('http://localhost/api/flows', {
      method: 'POST',
      body: JSON.stringify({ name: 'New Automation Flow' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(201)

    const body = await res.json()
    expect(body.flow.id).toBe('mock-flow-uuid')

    const flowsInserts = h.state.inserted.filter((i) => i.table === 'flows')
    expect(flowsInserts).toHaveLength(1)
    expect(flowsInserts[0].payload).toEqual({
      user_id: 'test-user-uuid',
      account_id: 'test-account-uuid',
      name: 'New Automation Flow',
      description: null,
      status: 'draft',
      trigger_type: 'keyword',
      trigger_config: {},
    })
  })

  it('clones flow template and stamps account_id on flow and flow_nodes', async () => {
    const req = new Request('http://localhost/api/flows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'My Welcome Flow',
        template_slug: 'welcome_menu',
      }),
    })
    const res = await POST(req)
    expect(res.status).toBe(201)

    const flowsInserts = h.state.inserted.filter((i) => i.table === 'flows')
    expect(flowsInserts).toHaveLength(1)
    expect(flowsInserts[0].payload.name).toBe('My Welcome Flow')
    expect(flowsInserts[0].payload.account_id).toBe('test-account-uuid')
    expect(flowsInserts[0].payload.user_id).toBe('test-user-uuid')

    const nodesInserts = h.state.inserted.filter((i) => i.table === 'flow_nodes')
    expect(nodesInserts).toHaveLength(1)
    // Should insert all nodes cloned from template
    expect(nodesInserts[0].payload).toHaveLength(4)
    expect(nodesInserts[0].payload[0].flow_id).toBe('mock-flow-uuid')
  })

  it('returns 400 if name is missing and no template is selected', async () => {
    const req = new Request('http://localhost/api/flows', {
      method: 'POST',
      body: JSON.stringify({ name: '' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('name is required')
  })

  it('returns 400 if invalid JSON body is sent', async () => {
    const req = new Request('http://localhost/api/flows', {
      method: 'POST',
      body: 'invalid-json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Invalid JSON')
  })
})
