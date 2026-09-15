import PDFDocument from 'pdfkit'

/**
 * Formats a currency amount nicely.
 */
function formatAmount(val) {
  if (val == null || val === '') return '$0.00'
  const num = Number(val)
  if (Number.isNaN(num)) return '$0.00'
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Formats a date string into readable YYYY-MM-DD.
 */
function formatDate(val) {
  if (!val) return '—'
  const d = new Date(val)
  if (Number.isNaN(d.getTime())) return String(val).slice(0, 10)
  return d.toISOString().slice(0, 10)
}

/**
 * Truncate long strings with ellipsis.
 */
function truncate(str, maxLen) {
  if (!str) return ''
  const s = String(str).trim().replace(/[\r\n\t]+/g, ' ')
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen - 1) + '…'
}

/**
 * Generates a professional statement PDF document buffer.
 *
 * @param {Object} meta Document metadata (filename, sourceType, dateFrom, dateTo, etc.)
 * @param {Array} rows Array of transaction objects
 * @returns {Promise<Buffer>}
 */
export function generateStatementPdf(meta = {}, rows = []) {
  return new Promise((resolve, reject) => {
    try {
      const filename = meta.filename || meta.id || 'Statement.pdf'
      const docType = (meta.document_type || meta.source_type || 'Bank Statement').toUpperCase()
      const employerOrBank = meta.employer_or_bank || meta.bank || meta.employer || 'Primary Account'
      
      const totalRows = rows.length
      let totalAmount = 0
      let matchedCount = 0
      let unmatchedCount = 0
      let pendingCount = 0

      let minDate = null
      let maxDate = null

      for (const r of rows) {
        const amt = Number(r.amount ?? r.EmiPaidAmount ?? r.emiPaidAmount ?? 0) || 0
        totalAmount += amt
        
        const st = String(r.status || r.ReviewStatus || '').toLowerCase()
        if (st === 'matched' || st === 'auto_matched' || st === 'confirmed') {
          matchedCount++
        } else if (st === 'unmatched' || st === 'exception') {
          unmatchedCount++
        } else {
          pendingCount++
        }

        const dStr = r.date || r.TransDate || r.transDate
        if (dStr) {
          const d = new Date(dStr)
          if (!Number.isNaN(d.getTime())) {
            if (!minDate || d < minDate) minDate = d
            if (!maxDate || d > maxDate) maxDate = d
          }
        }
      }

      const dateRangeStr = minDate && maxDate
        ? `${minDate.toISOString().slice(0, 10)} to ${maxDate.toISOString().slice(0, 10)}`
        : meta.date_from && meta.date_to
          ? `${formatDate(meta.date_from)} to ${formatDate(meta.date_to)}`
          : 'All Recorded Dates'

      // Landscape A4: 841.89 x 595.28 pt
      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margin: 30,
        bufferPages: true,
        info: {
          Title: `Statement - ${filename}`,
          Author: 'SmartRepay Platform',
          Subject: `${docType} Reconciliation Report`,
        },
      })

      const buffers = []
      doc.on('data', (b) => buffers.push(b))
      doc.on('end', () => resolve(Buffer.concat(buffers)))
      doc.on('error', (err) => reject(err))

      const pageWidth = 841.89
      const pageHeight = 595.28
      const margin = 30
      const contentWidth = pageWidth - margin * 2 // 781.89

      // Table Column Definitions (Sum = 781.89)
      const cols = [
        { label: '#', width: 30, align: 'center' },
        { label: 'Date', width: 65, align: 'left' },
        { label: 'Reference', width: 85, align: 'left' },
        { label: 'Description / Particulars', width: 250, align: 'left' },
        { label: 'Payer / Raw Borrower', width: 125, align: 'left' },
        { label: 'Matched Borrower / Loan', width: 125, align: 'left' },
        { label: 'Amount', width: 60, align: 'right' },
        { label: 'Status', width: 41, align: 'center' },
      ]

      const drawHeaderBanner = (isFirstPage) => {
        if (isFirstPage) {
          // Top accent bar
          doc.rect(margin, margin, contentWidth, 54).fill('#0f172a')

          // Title & Subtitle
          doc.fillColor('#ffffff').fontSize(14).font('Helvetica-Bold')
            .text('SMARTREPAY STATEMENT REPORT', margin + 14, margin + 12)
          doc.fillColor('#94a3b8').fontSize(9).font('Helvetica')
            .text(`Document: ${filename}  •  Source: ${employerOrBank}  •  Type: ${docType}`, margin + 14, margin + 32)

          // Summary Stats Badges (Right side of banner)
          const nowFormatted = new Date().toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })
          doc.fillColor('#38bdf8').fontSize(8).font('Helvetica-Bold')
            .text(`Generated: ${nowFormatted}`, margin + contentWidth - 160, margin + 14, { width: 150, align: 'right' })
          doc.fillColor('#cbd5e1').fontSize(8).font('Helvetica')
            .text(`Txn Range: ${dateRangeStr}`, margin + contentWidth - 210, margin + 32, { width: 200, align: 'right' })

          // Summary metrics cards row below header
          const cardY = margin + 62
          const cardH = 34
          const cardW = (contentWidth - 16) / 5

          const stats = [
            { label: 'TOTAL ROWS', val: String(totalRows), color: '#0f172a' },
            { label: 'TOTAL AMOUNT', val: formatAmount(totalAmount), color: '#0284c7' },
            { label: 'MATCHED', val: `${matchedCount} (${totalRows ? Math.round((matchedCount / totalRows) * 100) : 0}%)`, color: '#16a34a' },
            { label: 'UNMATCHED', val: `${unmatchedCount}`, color: '#dc2626' },
            { label: 'PENDING', val: `${pendingCount}`, color: '#d97706' },
          ]

          stats.forEach((s, idx) => {
            const cx = margin + idx * (cardW + 4)
            doc.rect(cx, cardY, cardW, cardH).fillAndStroke('#f8fafc', '#e2e8f0')
            doc.fillColor('#64748b').fontSize(6.5).font('Helvetica-Bold')
              .text(s.label, cx + 6, cardY + 5, { width: cardW - 12 })
            doc.fillColor(s.color).fontSize(10).font('Helvetica-Bold')
              .text(s.val, cx + 6, cardY + 16, { width: cardW - 12 })
          })
        }
      }

      const drawTableHeader = (y) => {
        doc.rect(margin, y, contentWidth, 20).fill('#0f766e')
        let x = margin
        doc.fillColor('#ffffff').fontSize(7.5).font('Helvetica-Bold')
        cols.forEach((col) => {
          doc.text(col.label, x + 3, y + 6, {
            width: col.width - 6,
            align: col.align,
          })
          x += col.width
        })
        return y + 20
      }

      // Initial page setup
      let isFirstPage = true
      drawHeaderBanner(isFirstPage)

      let currentY = margin + 104
      currentY = drawTableHeader(currentY)

      const rowHeight = 16
      const maxY = pageHeight - margin - 20

      rows.forEach((r, idx) => {
        if (currentY + rowHeight > maxY) {
          doc.addPage()
          isFirstPage = false
          // Compact header on subsequent pages
          doc.rect(margin, margin, contentWidth, 22).fill('#1e293b')
          doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold')
            .text(`${filename}  (Continued)`, margin + 8, margin + 6)
          doc.fillColor('#94a3b8').fontSize(7.5).font('Helvetica')
            .text(`SmartRepay Statement Export  •  Page ${doc.bufferedPageRange().count}`, margin + contentWidth - 180, margin + 7, { width: 170, align: 'right' })

          currentY = margin + 28
          currentY = drawTableHeader(currentY)
        }

        // Alternating row background
        const bg = idx % 2 === 0 ? '#ffffff' : '#f8fafc'
        doc.rect(margin, currentY, contentWidth, rowHeight).fillAndStroke(bg, '#f1f5f9')

        let x = margin
        const dateText = formatDate(r.date || r.TransDate || r.transDate)
        const refText = truncate(r.reference || r.ReferenceNo || r.referenceNo || '—', 18)
        const descText = truncate(
          r.transaction_description || r.description || r.particulars || r.Particulars || '—',
          55
        )
        const payerText = truncate(
          r.payer || r.BorrowerName || r.borrowerName || r.name || '—',
          24
        )
        
        const matchedName = r.matched_borrower_name || r.LoanDiskBorrowerName || ''
        const loanNum = r.loan_number || r.LoanNumber || r.matched_loan_numbers || ''
        const matchedText = matchedName
          ? truncate(loanNum ? `${matchedName} (#${loanNum})` : matchedName, 24)
          : loanNum
            ? `#${loanNum}`
            : '—'

        const amtText = formatAmount(r.amount ?? r.EmiPaidAmount ?? r.emiPaidAmount ?? 0)

        const st = String(r.status || r.ReviewStatus || '').toLowerCase()
        let statusBadge = 'Pending'
        let statusColor = '#d97706'
        if (st === 'matched' || st === 'auto_matched' || st === 'confirmed') {
          statusBadge = 'Matched'
          statusColor = '#16a34a'
        } else if (st === 'unmatched' || st === 'exception') {
          statusBadge = 'Unmatched'
          statusColor = '#dc2626'
        }

        // Render columns
        doc.fillColor('#64748b').fontSize(6.5).font('Helvetica')
          .text(String(idx + 1), x + 2, currentY + 4.5, { width: cols[0].width - 4, align: cols[0].align })
        x += cols[0].width

        doc.fillColor('#334155').fontSize(7).font('Helvetica')
          .text(dateText, x + 2, currentY + 4.5, { width: cols[1].width - 4, align: cols[1].align })
        x += cols[1].width

        doc.fillColor('#475569').fontSize(6.5).font('Helvetica')
          .text(refText, x + 2, currentY + 4.5, { width: cols[2].width - 4, align: cols[2].align })
        x += cols[2].width

        doc.fillColor('#0f172a').fontSize(6.8).font('Helvetica')
          .text(descText, x + 2, currentY + 4.5, { width: cols[3].width - 4, align: cols[3].align })
        x += cols[3].width

        doc.fillColor('#334155').fontSize(6.8).font('Helvetica')
          .text(payerText, x + 2, currentY + 4.5, { width: cols[4].width - 4, align: cols[4].align })
        x += cols[4].width

        doc.fillColor(matchedName ? '#0f766e' : '#64748b').fontSize(6.8).font(matchedName ? 'Helvetica-Bold' : 'Helvetica')
          .text(matchedText, x + 2, currentY + 4.5, { width: cols[5].width - 4, align: cols[5].align })
        x += cols[5].width

        doc.fillColor('#0f172a').fontSize(7).font('Helvetica-Bold')
          .text(amtText, x + 2, currentY + 4.5, { width: cols[6].width - 4, align: cols[6].align })
        x += cols[6].width

        doc.fillColor(statusColor).fontSize(6.5).font('Helvetica-Bold')
          .text(statusBadge, x + 1, currentY + 4.5, { width: cols[7].width - 2, align: cols[7].align })

        currentY += rowHeight
      })

      // Add footers on all buffered pages
      const totalPages = doc.bufferedPageRange().count
      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i)
        doc.rect(margin, pageHeight - margin - 12, contentWidth, 1).fill('#e2e8f0')
        doc.fillColor('#94a3b8').fontSize(6.5).font('Helvetica')
          .text(
            'SmartRepay Platform • Automated Financial Statement & Matching Reconciliation Report',
            margin,
            pageHeight - margin - 8,
            { width: 400, align: 'left' }
          )
        doc.text(
          `Page ${i + 1} of ${totalPages}`,
          margin + contentWidth - 100,
          pageHeight - margin - 8,
          { width: 100, align: 'right' }
        )
      }

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}
