import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Download, ExternalLink, FileOutput, Loader2 } from 'lucide-react'
import * as api from '@/lib/api'
import {
  CRIF_ASCII_OPTIONS,
  CRIF_CATEGORY_OPTIONS,
  CRIF_COMPANY_OPTIONS,
  CRIF_LENGTH_OPTIONS,
} from '@/lib/crifConstants'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardBody, CardHeader } from '@/components/Card'
import { cn } from '@/lib/utils'

function validateForm({
  category,
  selectedBranches,
  asciiCode,
  asciiCustom,
  length,
  lengthCustom,
  borrowerId,
}) {
  if (!category) return 'Category is required'
  if (!selectedBranches.length) return 'Select at least one company'
  if (!asciiCode) return 'ASCII code is required'
  if (asciiCode === 'Other' && !String(asciiCustom).trim()) return 'Enter a hard stop code'
  if (asciiCode === 'Other' && !/^\d+$/.test(String(asciiCustom).trim())) {
    return 'Hard stop code must contain digits only'
  }
  if (!length) return 'Character length is required'
  if (length === 'Other' && !String(lengthCustom).trim()) return 'Enter a character length'
  if (length === 'Other' && !/^\d+$/.test(String(lengthCustom).trim())) {
    return 'Character length must contain digits only'
  }
  if (borrowerId && !/^\d+$/.test(String(borrowerId).trim())) {
    return 'Borrower ID must contain digits only'
  }
  return null
}

function fileNameFromUrl(fileUrl, category) {
  const fromUrl = String(fileUrl || '').split('/').pop()?.split('?')[0]
  if (fromUrl) return fromUrl
  return category === 'Contract' ? 'CRIF_Contract_File.txt' : 'CRIF_Subject_File.txt'
}

/** Force a real local download via our API proxy (attachment), not open-in-tab. */
async function downloadCrifTextFile(fileUrl, category) {
  const { blob, fileName } = await api.crif.downloadGeneratedFile(fileUrl)
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName || fileNameFromUrl(fileUrl, category)
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  // Give the browser a moment to start the download before revoking
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500)
}

export function CrifGenerateFile() {
  const [category, setCategory] = useState('Borrower')
  const [selectedBranches, setSelectedBranches] = useState([])
  const [borrowerId, setBorrowerId] = useState('')
  const [asciiCode, setAsciiCode] = useState('1')
  const [asciiCustom, setAsciiCustom] = useState('')
  const [length, setLength] = useState('1500')
  const [lengthCustom, setLengthCustom] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const lengthOptions = useMemo(
    () => CRIF_LENGTH_OPTIONS[category] ?? CRIF_LENGTH_OPTIONS.Borrower,
    [category]
  )

  function toggleBranch(id) {
    setSelectedBranches((prev) =>
      prev.includes(id) ? prev.filter((b) => b !== id) : [...prev, id]
    )
  }

  function handleCategoryChange(next) {
    setCategory(next)
    setSelectedBranches([])
    setLength(next === 'Contract' ? '800' : '1500')
    setLengthCustom('')
    setError(null)
    setResult(null)
  }

  function resetForm() {
    setCategory('Borrower')
    setSelectedBranches([])
    setBorrowerId('')
    setAsciiCode('1')
    setAsciiCustom('')
    setLength('1500')
    setLengthCustom('')
    setSubmitted(false)
    setError(null)
    setResult(null)
  }

  async function handleGenerate() {
    setSubmitted(true)
    const validationError = validateForm({
      category,
      selectedBranches,
      asciiCode,
      asciiCustom,
      length,
      lengthCustom,
      borrowerId,
    })
    if (validationError) {
      setError(validationError)
      toast.error(validationError)
      return
    }

    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const data = await api.crif.generateFile({
        category,
        branchIds: selectedBranches,
        borrowerId: borrowerId.trim(),
        asciiCode,
        asciiCustom: asciiCustom.trim(),
        length,
        lengthCustom: lengthCustom.trim(),
      })
      setResult(data)
      toast.success(data.message || 'File generated successfully')

      try {
        await downloadCrifTextFile(data.fileUrl, category)
      } catch (downloadErr) {
        toast.error(downloadErr.message || 'File generated, but local download failed — use Download file')
      }
    } catch (e) {
      setError(e.message || 'Failed to generate file')
      toast.error(e.message || 'Failed to generate file')
    } finally {
      setLoading(false)
    }
  }

  const selectClass =
    'flex h-10 w-full rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-3 text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]'

  return (
    <div>
      <PageHeader
        eyebrow="CRIF"
        title="Generate CRIF File"
        subtitle="Export subject or contract CRIF files using the same API flow as Simplified."
      />

      <Card>
        <CardHeader title="Generate file" />
        <CardBody className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="category">Category</Label>
              <select
                id="category"
                className={selectClass}
                value={category}
                onChange={(e) => handleCategoryChange(e.target.value)}
                disabled={loading}
              >
                {CRIF_CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {submitted && !category && (
                <p className="text-[12px] text-[var(--danger)]">Category is required</p>
              )}
            </div>

            <div className="space-y-1.5 sm:col-span-2 xl:col-span-2">
              <Label>Companies</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {CRIF_COMPANY_OPTIONS.map((company) => {
                  const checked = selectedBranches.includes(company.id)
                  return (
                    <label
                      key={company.id}
                      className={cn(
                        'flex items-center gap-3 rounded-[var(--radius-md)] border px-3 py-2.5 cursor-pointer transition-colors duration-100',
                        checked
                          ? 'border-[var(--accent)] bg-[var(--bg-subtle)]'
                          : 'border-[var(--border-light)] hover:bg-[var(--bg-hover)]'
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleBranch(company.id)}
                        disabled={loading}
                        className="h-4 w-4 accent-[var(--accent)]"
                      />
                      <span className="text-[13px] font-medium text-[var(--text-primary)]">{company.label}</span>
                    </label>
                  )
                })}
              </div>
              {submitted && !selectedBranches.length && (
                <p className="text-[12px] text-[var(--danger)]">At least one company is required</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="borrowerId">Borrower ID</Label>
              <Input
                id="borrowerId"
                value={borrowerId}
                onChange={(e) => setBorrowerId(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="Optional"
                disabled={loading}
                inputMode="numeric"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="asciiCode">ASCII code</Label>
              <select
                id="asciiCode"
                className={selectClass}
                value={asciiCode}
                onChange={(e) => setAsciiCode(e.target.value)}
                disabled={loading}
              >
                {CRIF_ASCII_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {submitted && !asciiCode && (
                <p className="text-[12px] text-[var(--danger)]">ASCII code is required</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="length">Character length</Label>
              <select
                id="length"
                className={selectClass}
                value={length}
                onChange={(e) => setLength(e.target.value)}
                disabled={loading}
              >
                {lengthOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {submitted && !length && (
                <p className="text-[12px] text-[var(--danger)]">Character length is required</p>
              )}
            </div>

            {asciiCode === 'Other' && (
              <div className="space-y-1.5">
                <Label htmlFor="asciiCustom">Hard stop code</Label>
                <Input
                  id="asciiCustom"
                  value={asciiCustom}
                  onChange={(e) => setAsciiCustom(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="Enter hard stop code"
                  disabled={loading}
                  inputMode="numeric"
                />
                {submitted && !asciiCustom.trim() && (
                  <p className="text-[12px] text-[var(--danger)]">Hard stop code is required</p>
                )}
              </div>
            )}

            {length === 'Other' && (
              <div className="space-y-1.5">
                <Label htmlFor="lengthCustom">Custom character length</Label>
                <Input
                  id="lengthCustom"
                  value={lengthCustom}
                  onChange={(e) => setLengthCustom(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="Enter character length"
                  disabled={loading}
                  inputMode="numeric"
                />
                {submitted && !lengthCustom.trim() && (
                  <p className="text-[12px] text-[var(--danger)]">Character length is required</p>
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-[var(--radius-md)] border border-[var(--danger)]/30 bg-[var(--danger-bg)] px-3 py-2 text-[13px] text-[var(--danger)]">
              {error}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={handleGenerate} disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Processing… ({selectedBranches.length} {selectedBranches.length === 1 ? 'company' : 'companies'})
                </>
              ) : (
                <>
                  <FileOutput className="h-4 w-4 mr-2" />
                  Generate {category === 'Contract' ? 'Contract' : 'Subject'} file
                </>
              )}
            </Button>
            <Button type="button" variant="secondary" onClick={resetForm} disabled={loading}>
              Cancel
            </Button>
          </div>
        </CardBody>
      </Card>

      {result?.fileUrl && (
        <Card className="mt-6">
          <CardHeader
            title="File ready"
            subtitle={
              result.usedFallback
                ? `${result.message} (used legacy generator — node dynamic export had no data)`
                : result.message
            }
          />
          <CardBody className="flex flex-wrap gap-2">
            <Button asChild variant="secondary">
              <a href={result.fileUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4 mr-2" />
                View file
              </a>
            </Button>
            <Button
              type="button"
              onClick={() => downloadCrifTextFile(result.fileUrl, result.category || category)}
            >
              <Download className="h-4 w-4 mr-2" />
              Download file
            </Button>
          </CardBody>
        </Card>
      )}
    </div>
  )
}
