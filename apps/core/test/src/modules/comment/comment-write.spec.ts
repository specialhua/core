import { describe, expect, it } from 'vitest'

import {
  createCommentRow,
  createCommentServiceFixture,
} from '@/helper/comment-service-fixture'
import { CollectionRefTypes } from '~/constants/db.constant'
import { CommentState } from '~/modules/comment/comment.enum'

describe('CommentService write operations', () => {
  it('creates root comments through the PG repository with resolved ref type', async () => {
    const { repository, service } = createCommentServiceFixture()
    repository.create.mockResolvedValue(createCommentRow())

    await service.createComment('post-1', { text: 'hello', author: 'Alice' })

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'hello',
        author: 'Alice',
        refId: 'post-1',
        refType: CollectionRefTypes.Post,
        state: CommentState.Unread,
        parentCommentId: null,
        rootCommentId: null,
      }),
    )
  })

  it('persists country code on new comments and leaves is_owner_reply default false', async () => {
    const { commentCountryService, repository, service } =
      createCommentServiceFixture()
    commentCountryService.lookupCountryCode.mockResolvedValue('JP')
    repository.create.mockResolvedValue(createCommentRow())

    await service.createComment('post-1', {
      text: 'hi',
      author: 'Alice',
      ip: '1.2.3.4',
    })

    expect(commentCountryService.lookupCountryCode).toHaveBeenCalledWith(
      '1.2.3.4',
      expect.objectContaining({ cfHint: null }),
    )
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ countryCode: 'JP' }),
    )
    // Root comments are never owner replies.
    expect(repository.create.mock.calls[0]?.[0]?.isOwnerReply).toBeUndefined()
  })

  it('flags owner replies and stamps country code on replyComment', async () => {
    const { commentCountryService, repository, service } =
      createCommentServiceFixture()
    commentCountryService.lookupCountryCode.mockResolvedValue('CN')
    repository.findById.mockResolvedValue(
      createCommentRow({
        id: 'parent-1',
        refType: CollectionRefTypes.Post,
        refId: 'post-1',
        rootCommentId: null,
        state: CommentState.Read,
      }),
    )
    repository.createReply.mockResolvedValue(
      createCommentRow({ id: 'reply-1' }),
    )

    const { RequestContext } = await import('~/common/contexts/request.context')
    const reqCtx = new RequestContext(
      { headers: { 'cf-ipcountry': 'CN' }, hasAdminAccess: true } as any,
      {} as any,
    )

    await RequestContext.run(reqCtx, async () => {
      await service.replyComment('parent-1', { text: 'hi', ip: '1.2.3.4' })
    })

    expect(repository.createReply).toHaveBeenCalledWith(
      expect.objectContaining({
        parentCommentId: 'parent-1',
        isOwnerReply: true,
        countryCode: 'CN',
      }),
    )
    expect(commentCountryService.lookupCountryCode).toHaveBeenCalledWith(
      '1.2.3.4',
      { cfHint: 'CN' },
    )
  })

  it('does not flag isOwnerReply when actor lacks admin access', async () => {
    const { repository, service } = createCommentServiceFixture()
    repository.findById.mockResolvedValue(
      createCommentRow({ id: 'parent-1', state: CommentState.Read }),
    )
    repository.createReply.mockResolvedValue(
      createCommentRow({ id: 'reply-1' }),
    )

    await service.replyComment('parent-1', { text: 'hi', ip: '1.2.3.4' })

    expect(repository.createReply).toHaveBeenCalledWith(
      expect.objectContaining({ isOwnerReply: false }),
    )
  })

  it('updates comment state in bulk through a repository batch call', async () => {
    const { repository, service } = createCommentServiceFixture()
    repository.updateStateBulk.mockResolvedValue(2)

    await expect(
      service.updateStateBulk(['comment-1', 'comment-2'], CommentState.Read),
    ).resolves.toBe(2)
    expect(repository.updateStateBulk).toHaveBeenCalledWith(
      ['comment-1', 'comment-2'],
      CommentState.Read,
    )
  })

  describe('reader image binding', () => {
    const runAsReader = async <T>(fn: () => Promise<T>) => {
      const { RequestContext } =
        await import('~/common/contexts/request.context')
      const reqCtx = new RequestContext(
        { headers: {}, readerId: 'reader-1' } as any,
        {} as any,
      )
      return RequestContext.run(reqCtx, fn)
    }

    const createReaderFixture = () => {
      const fixture = createCommentServiceFixture()
      fixture.readerService.findReaderInIds.mockResolvedValue([
        { name: 'Reader', email: 'reader@example.com' },
      ])
      return fixture
    }

    const text = 'look ![](https://cdn.example.com/comments/reader-1/a.png)'

    it('attaches uploaded images when a reader creates a comment', async () => {
      const { fileReferenceService, repository, service } =
        createReaderFixture()
      repository.create.mockResolvedValue(
        createCommentRow({ id: 'comment-9', readerId: 'reader-1' }),
      )

      await runAsReader(() => service.createComment('post-1', { text }))

      expect(
        fileReferenceService.attachReaderImagesToComment,
      ).toHaveBeenCalledWith({
        commentId: 'comment-9',
        readerId: 'reader-1',
        text,
        mode: 'create',
      })
    })

    it('attaches uploaded images when a reader replies', async () => {
      const { fileReferenceService, repository, service } =
        createReaderFixture()
      repository.findById.mockResolvedValue(
        createCommentRow({ id: 'parent-1', state: CommentState.Read }),
      )
      repository.createReply.mockResolvedValue(
        createCommentRow({ id: 'reply-9', readerId: 'reader-1' }),
      )

      await runAsReader(() => service.replyComment('parent-1', { text }))

      expect(
        fileReferenceService.attachReaderImagesToComment,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ commentId: 'reply-9', mode: 'create' }),
      )
    })

    it('rolls back the comment when attaching images is rejected', async () => {
      const { fileReferenceService, repository, service } =
        createReaderFixture()
      repository.create.mockResolvedValue(
        createCommentRow({ id: 'comment-9', readerId: 'reader-1' }),
      )
      repository.deleteById.mockResolvedValue(null)
      const error = new Error('cap exceeded')
      fileReferenceService.attachReaderImagesToComment.mockRejectedValue(error)

      await expect(
        runAsReader(() => service.createComment('post-1', { text })),
      ).rejects.toBe(error)
      expect(repository.deleteById).toHaveBeenCalledWith('comment-9')
    })

    it('does not attach images for anonymous comments', async () => {
      const { fileReferenceService, repository, service } =
        createCommentServiceFixture()
      repository.create.mockResolvedValue(createCommentRow())

      await service.createComment('post-1', { text, author: 'Alice' })

      expect(
        fileReferenceService.attachReaderImagesToComment,
      ).not.toHaveBeenCalled()
    })

    it('re-syncs images on reader edits and restores text on failure', async () => {
      const { fileReferenceService, repository, service } =
        createCommentServiceFixture()
      const original = createCommentRow({
        id: 'comment-9',
        readerId: 'reader-1',
        text: 'old',
      })
      repository.findById.mockResolvedValue(original)
      repository.update.mockResolvedValue(original)

      await service.editComment('comment-9', text)
      expect(
        fileReferenceService.attachReaderImagesToComment,
      ).toHaveBeenCalledWith({
        commentId: 'comment-9',
        readerId: 'reader-1',
        text,
        mode: 'update',
      })

      const error = new Error('not owned')
      fileReferenceService.attachReaderImagesToComment.mockRejectedValue(error)
      await expect(service.editComment('comment-9', text)).rejects.toBe(error)
      expect(repository.update).toHaveBeenLastCalledWith('comment-9', {
        text: 'old',
        editedAt: null,
      })
    })
  })
})
