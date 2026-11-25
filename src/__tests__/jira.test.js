const JiraChecker = require('../jira')

describe('JiraChecker', () => {
  describe('check', () => {
    test('should pass when JIRA check is disabled', () => {
      const result = JiraChecker.check('feat: add new feature', { required: false })
      expect(result.valid).toBe(true)
      expect(result.message).toBe('JIRA check disabled')
    })

    test('should fail when JIRA ticket is required but missing', () => {
      const result = JiraChecker.check('feat: add new feature', { required: true })
      expect(result.valid).toBe(false)
      expect(result.message).toContain('JIRA ticket reference not found')
    })

    test('should pass when JIRA ticket is present', () => {
      const result = JiraChecker.check('feat: add new feature ABC-123', { required: true })
      expect(result.valid).toBe(true)
      expect(result.message).toBe('JIRA ticket reference found in commit message')
    })

    test('should work with custom pattern', () => {
      const config = { required: true, pattern: 'PROJ-\\d+' }
      const result = JiraChecker.check('fix: bug fix PROJ-456', config)
      expect(result.valid).toBe(true)
    })

    test('is off when no config is given', () => {
      expect(JiraChecker.check('no ticket here')).toMatchObject({ valid: true })
    })
  })

  describe('extractTicketIds', () => {
    test('should extract single JIRA ticket', () => {
      const tickets = JiraChecker.extractTicketIds('feat: add feature ABC-123')
      expect(tickets).toEqual(['ABC-123'])
    })

    test('should extract multiple JIRA tickets', () => {
      const tickets = JiraChecker.extractTicketIds('feat: merge ABC-123 and DEF-456')
      expect(tickets).toEqual(['ABC-123', 'DEF-456'])
    })

    test('should return empty array when no tickets found', () => {
      const tickets = JiraChecker.extractTicketIds('feat: add new feature')
      expect(tickets).toEqual([])
    })

    test('should work with custom pattern', () => {
      const config = { pattern: 'PROJ-\\d+' }
      const tickets = JiraChecker.extractTicketIds('fix: PROJ-123 and ABC-456', config)
      expect(tickets).toEqual(['PROJ-123'])
    })
  })

  describe('checkProjectFormat', () => {
    test('should pass when no project restrictions', () => {
      const result = JiraChecker.checkProjectFormat('ABC-123', {})
      expect(result.valid).toBe(true)
    })

    test('has no restrictions when no config is given', () => {
      expect(JiraChecker.checkProjectFormat('ABC-1').valid).toBe(true)
    })

    test('should pass when project is in allowed list', () => {
      const config = { allowedProjects: ['ABC', 'DEF'] }
      const result = JiraChecker.checkProjectFormat('ABC-123', config)
      expect(result.valid).toBe(true)
    })

    test('should fail when project is not in allowed list', () => {
      const config = { allowedProjects: ['ABC', 'DEF'] }
      const result = JiraChecker.checkProjectFormat('XYZ-123', config)
      expect(result.valid).toBe(false)
      expect(result.message).toContain('not in allowed list')
    })
  })

  describe('checkTicketPosition', () => {
    test('should pass when ticket is at start and position is start', () => {
      const config = { position: 'start' }
      const result = JiraChecker.checkTicketPosition('ABC-123 feat: add feature', config)
      expect(result.valid).toBe(true)
    })

    test('should fail when ticket is not at start but position is start', () => {
      const config = { position: 'start' }
      const result = JiraChecker.checkTicketPosition('feat: add feature ABC-123', config)
      expect(result.valid).toBe(false)
    })

    test('is anywhere when no position is configured', () => {
      expect(JiraChecker.checkTicketPosition('fix ABC-1 here')).toMatchObject({
        valid: true,
        message: 'JIRA ticket is in the correct position (anywhere)'
      })
    })

    test('should fail when no ticket is present', () => {
      expect(JiraChecker.checkTicketPosition('no ticket', { position: 'start' })).toMatchObject({
        valid: false,
        message: 'No JIRA ticket found in commit message'
      })
    })

    test('should pass when ticket is at end and position is end', () => {
      expect(JiraChecker.checkTicketPosition('fix login ABC-123', { position: 'end' }).valid).toBe(true)
    })

    test('should fail when ticket is not at end but position is end', () => {
      expect(JiraChecker.checkTicketPosition('ABC-123 fix login', { position: 'end' })).toMatchObject({
        valid: false,
        message: 'JIRA ticket must be at the end of commit message'
      })
    })

    test('should fail for an unknown position', () => {
      expect(JiraChecker.checkTicketPosition('ABC-123 fix', { position: 'middle' })).toMatchObject({
        valid: false,
        message: 'Unknown position requirement: middle'
      })
    })

    test('should pass when position is anywhere', () => {
      const config = { position: 'anywhere' }
      const result = JiraChecker.checkTicketPosition('feat: ABC-123 add feature', config)
      expect(result.valid).toBe(true)
    })
  })

  describe('checkMultipleTickets', () => {
    test('should pass when multiple tickets are allowed', () => {
      const config = { allowMultiple: true }
      const result = JiraChecker.checkMultipleTickets('feat: ABC-123 DEF-456', config)
      expect(result.valid).toBe(true)
    })

    test('should fail when multiple tickets are not allowed', () => {
      const config = { allowMultiple: false }
      const result = JiraChecker.checkMultipleTickets('feat: ABC-123 DEF-456', config)
      expect(result.valid).toBe(false)
    })

    test('should fail when exceeding max tickets', () => {
      const config = { maxTickets: 1 }
      const result = JiraChecker.checkMultipleTickets('feat: ABC-123 DEF-456', config)
      expect(result.valid).toBe(false)
    })

    test('should fail when duplicate tickets found', () => {
      const result = JiraChecker.checkMultipleTickets('feat: ABC-123 ABC-123')
      expect(result.valid).toBe(false)
      expect(result.message).toContain('Duplicate JIRA tickets')
    })
  })

  describe('validateTicketFormat', () => {
    test('should pass for valid format', () => {
      const result = JiraChecker.validateTicketFormat('ABC-123')
      expect(result.valid).toBe(true)
    })

    test('should fail for invalid format', () => {
      const result = JiraChecker.validateTicketFormat('abc-123')
      expect(result.valid).toBe(false)
    })

    test('should fail for project key too short', () => {
      const config = { minProjectLength: 3 }
      const result = JiraChecker.validateTicketFormat('AB-123', config)
      expect(result.valid).toBe(false)
    })

    test('should fail for ticket number out of range', () => {
      const config = { minTicketNumber: 100 }
      const result = JiraChecker.validateTicketFormat('ABC-50', config)
      expect(result.valid).toBe(false)
    })
  })

  describe('getTicketUrl', () => {
    test('should generate URL with default base URL', () => {
      const url = JiraChecker.getTicketUrl('ABC-123')
      expect(url).toBe('https://your-jira-instance.atlassian.net/browse/ABC-123')
    })

    test('should generate URL with custom base URL', () => {
      const config = { baseUrl: 'https://company.atlassian.net' }
      const url = JiraChecker.getTicketUrl('ABC-123', config)
      expect(url).toBe('https://company.atlassian.net/browse/ABC-123')
    })
  })

  describe('validateConfig', () => {
    test('should pass for valid config', () => {
      const config = {
        required: true,
        pattern: '[A-Z]+-\\d+',
        position: 'start',
        maxTickets: 2,
        baseUrl: 'https://company.atlassian.net'
      }
      const result = JiraChecker.validateConfig(config)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    test('should fail for invalid regex pattern', () => {
      const config = { pattern: '[invalid regex' }
      const result = JiraChecker.validateConfig(config)
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain('Invalid JIRA pattern regex')
    })

    test('should fail for invalid position', () => {
      const config = { position: 'invalid' }
      const result = JiraChecker.validateConfig(config)
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain('Invalid position value')
    })

    test('should fail for invalid maxTickets', () => {
      const config = { maxTickets: -1 }
      const result = JiraChecker.validateConfig(config)
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain('maxTickets must be a positive number')
    })

    test('should fail for invalid baseUrl', () => {
      const config = { baseUrl: 'not-a-url' }
      const result = JiraChecker.validateConfig(config)
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain('baseUrl must be a valid HTTP/HTTPS URL')
    })
  })
})
