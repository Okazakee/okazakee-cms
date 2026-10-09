'use client';

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { EditorGroup } from '@/components/cms/shared/EditorBody';
import type {
  ResumeContactIcon,
  ResumeData,
  ResumeEducation,
  ResumeExperience,
  ResumeLanguage,
  ResumeProject,
  ResumeSkillGroup,
} from '@/libs/resume/types';
import { isLinkableContactIcon } from '@/libs/resume/types';
import { Field, ListEditor, TextInput } from './ResumeFields';
import { RichTextEditor } from './RichTextEditor';

/** Friendlier row names than the raw icon keys where it matters. */
const CONTACT_ROW_LABELS: Record<ResumeContactIcon, string> = {
  location: 'location',
  phone: 'phone',
  email: 'email',
  github: 'github',
  linkedin: 'linkedin',
  website: 'website',
  document: 'vat number',
};
const EMPTY_SKILL: ResumeSkillGroup = { label: '', tags: [] };
const EMPTY_JOB: ResumeExperience = {
  title: '',
  sub: '',
  meta: '',
  bullets: [''],
};
const EMPTY_PROJECT: ResumeProject = {
  name: '',
  links: [],
  stack: '',
  bullets: [''],
};
const EMPTY_EDUCATION: ResumeEducation = {
  degree: '',
  school: '',
  year: '',
};
const EMPTY_LANGUAGE: ResumeLanguage = { name: '', level: '' };

/** Per-bullet rich editors: formatting comes from the toolbar, never typed. */
function BulletEditor({
  items,
  onChange,
}: {
  items: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useTranslations('cms.resume.builder');
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const current = next[index];
    const other = next[target];
    if (current === undefined || other === undefined) return;
    next[index] = other;
    next[target] = current;
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {items.map((bullet, index) => (
        <div key={index} className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <RichTextEditor
              value={bullet}
              minHeight={40}
              onChange={(text) =>
                onChange(items.map((b, i) => (i === index ? text : b)))
              }
            />
          </div>
          <div className="flex shrink-0 flex-col">
            <button
              type="button"
              aria-label={t('moveUp')}
              title={t('moveUp')}
              disabled={index === 0}
              onClick={() => move(index, -1)}
              className="rounded-md p-2 text-text-muted transition-colors hover:bg-surface-raised disabled:opacity-30"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={t('moveDown')}
              title={t('moveDown')}
              disabled={index === items.length - 1}
              onClick={() => move(index, 1)}
              className="rounded-md p-2 text-text-muted transition-colors hover:bg-surface-raised disabled:opacity-30"
            >
              <ArrowDown className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={t('removeEntry')}
              title={t('removeEntry')}
              onClick={() => onChange(items.filter((_, i) => i !== index))}
              className="rounded-md p-2 text-red-400 transition-colors hover:bg-red-500/10"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...items, ''])}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-dashed border-border-subtle px-4 py-2 text-sm text-text-muted transition-colors hover:border-accent-violet hover:text-text-main"
      >
        <Plus className="h-4 w-4" />
        {t('addBullet')}
      </button>
    </div>
  );
}

export function ResumeLocaleForm({
  data,
  onChange,
}: {
  data: ResumeData;
  onChange: (next: ResumeData) => void;
}) {
  const t = useTranslations('cms.resume.builder');
  const patch = (p: Partial<ResumeData>) => onChange({ ...data, ...p });
  const listLabels = {
    addLabel: '',
    upLabel: t('moveUp'),
    downLabel: t('moveDown'),
    removeLabel: t('removeEntry'),
  };

  return (
    <div className="space-y-6">
      <EditorGroup id="resume-header" title={t('headerGroup')}>
        <Field label={t('nameLabel')}>
          <TextInput value={data.name} onChange={(v) => patch({ name: v })} />
        </Field>
        <Field label={t('headlineLabel')}>
          <TextInput value={data.title} onChange={(v) => patch({ title: v })} />
        </Field>
        {/* Fixed header schema: text (and link where one exists) only. */}
        <div className="space-y-3">
          {data.contacts.map((contact, index) => (
            <div
              key={contact.icon}
              className="grid gap-2 rounded-xl border border-border-subtle bg-surface-base p-3 sm:grid-cols-[110px_1fr]"
            >
              <span className="self-center font-mono text-xs text-text-muted">
                {CONTACT_ROW_LABELS[contact.icon]}
              </span>
              <div className="space-y-2">
                <TextInput
                  value={contact.text}
                  onChange={(text) =>
                    onChange({
                      ...data,
                      contacts: data.contacts.map((current, i) =>
                        i === index ? { ...current, text } : current
                      ),
                    })
                  }
                />
                {isLinkableContactIcon(contact.icon) && (
                  <TextInput
                    mono
                    value={contact.href ?? ''}
                    onChange={(href) =>
                      onChange({
                        ...data,
                        contacts: data.contacts.map((current, i) =>
                          i === index ? { ...current, href } : current
                        ),
                      })
                    }
                    placeholder="https://… / mailto:… / tel:…"
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </EditorGroup>

      <EditorGroup id="resume-summary" title={t('summaryGroup')}>
        <Field label={t('sectionTitleLabel')}>
          <TextInput
            value={data.summaryTitle}
            onChange={(summaryTitle) => patch({ summaryTitle })}
          />
        </Field>
        <Field label={t('summaryLabel')}>
          <RichTextEditor
            value={data.summaryHtml}
            minHeight={120}
            onChange={(summaryHtml) => patch({ summaryHtml })}
          />
        </Field>
      </EditorGroup>

      <EditorGroup id="resume-skills" title={t('skillsGroup')}>
        <Field label={t('sectionTitleLabel')}>
          <TextInput
            value={data.skillsTitle}
            onChange={(skillsTitle) => patch({ skillsTitle })}
          />
        </Field>
        <ListEditor
          {...listLabels}
          addLabel={t('addSkill')}
          items={data.skills}
          onChange={(skills) => patch({ skills })}
          onCreate={() => ({ ...EMPTY_SKILL, tags: [] })}
          renderItem={(item, onPatch) => (
            <div className="space-y-2">
              <Field label={t('skillLabel')}>
                <TextInput
                  value={item.label}
                  onChange={(label) => onPatch({ label })}
                />
              </Field>
              <Field label={t('tagsLabel')} hint={t('tagsHint')}>
                <TextInput
                  value={item.tags.join(', ')}
                  onChange={(v) =>
                    onPatch({
                      tags: v
                        .split(',')
                        .map((tag) => tag.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </Field>
            </div>
          )}
        />
      </EditorGroup>

      <EditorGroup id="resume-experience" title={t('experienceGroup')}>
        <Field label={t('sectionTitleLabel')}>
          <TextInput
            value={data.experienceTitle}
            onChange={(experienceTitle) => patch({ experienceTitle })}
          />
        </Field>
        <ListEditor
          {...listLabels}
          addLabel={t('addJob')}
          items={data.experience}
          onChange={(experience) => patch({ experience })}
          onCreate={() => ({ ...EMPTY_JOB, bullets: [''] })}
          renderItem={(item, onPatch) => (
            <div className="space-y-2">
              <Field label={t('jobTitle')}>
                <TextInput
                  value={item.title}
                  onChange={(title) => onPatch({ title })}
                />
              </Field>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label={t('jobSub')}>
                  <TextInput
                    value={item.sub}
                    onChange={(sub) => onPatch({ sub })}
                  />
                </Field>
                <Field label={t('jobMeta')}>
                  <TextInput
                    value={item.meta}
                    onChange={(meta) => onPatch({ meta })}
                  />
                </Field>
              </div>
              <Field label={t('bulletsLabel')}>
                <BulletEditor
                  items={item.bullets}
                  onChange={(bullets) => onPatch({ bullets })}
                />
              </Field>
            </div>
          )}
        />
      </EditorGroup>

      <EditorGroup id="resume-projects" title={t('projectsGroup')}>
        <Field label={t('sectionTitleLabel')}>
          <TextInput
            value={data.projectsTitle}
            onChange={(projectsTitle) => patch({ projectsTitle })}
          />
        </Field>
        <ListEditor
          {...listLabels}
          addLabel={t('addProject')}
          items={data.projects}
          onChange={(projects) => patch({ projects })}
          onCreate={() => ({ ...EMPTY_PROJECT, bullets: [''], links: [] })}
          renderItem={(item, onPatch) => (
            <div className="space-y-2">
              <Field label={t('projectName')}>
                <TextInput
                  value={item.name}
                  onChange={(name) => onPatch({ name })}
                />
              </Field>
              <Field label={t('stackLabel')}>
                <TextInput
                  value={item.stack}
                  onChange={(stack) => onPatch({ stack })}
                />
              </Field>
              <ListEditor
                {...listLabels}
                addLabel={t('addLink')}
                items={item.links}
                onChange={(links) => onPatch({ links })}
                onCreate={() => ({ label: '', href: '' })}
                renderItem={(link, onLinkPatch) => (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label={t('linkTextLabel')}>
                      <TextInput
                        value={link.label}
                        onChange={(label) => onLinkPatch({ label })}
                      />
                    </Field>
                    <Field label={t('contactHref')}>
                      <TextInput
                        mono
                        value={link.href}
                        onChange={(href) => onLinkPatch({ href })}
                      />
                    </Field>
                  </div>
                )}
              />
              <Field label={t('bulletsLabel')}>
                <BulletEditor
                  items={item.bullets}
                  onChange={(bullets) => onPatch({ bullets })}
                />
              </Field>
            </div>
          )}
        />
      </EditorGroup>

      <EditorGroup id="resume-education" title={t('educationGroup')}>
          <Field label={t('sectionTitleLabel')}>
            <TextInput
              value={data.educationTitle}
              onChange={(educationTitle) => patch({ educationTitle })}
            />
          </Field>
          <ListEditor
            {...listLabels}
            addLabel={t('addEducation')}
            items={data.education}
            onChange={(education) => patch({ education })}
            onCreate={() => ({ ...EMPTY_EDUCATION })}
            renderItem={(item, onPatch) => (
              <div className="space-y-2">
                <Field label={t('degreeLabel')}>
                  <TextInput
                    value={item.degree}
                    onChange={(degree) => onPatch({ degree })}
                  />
                </Field>
                <Field label={t('schoolLabel')}>
                  <TextInput
                    value={item.school}
                    onChange={(school) => onPatch({ school })}
                  />
                </Field>
                <Field label={t('yearLabel')}>
                  <TextInput
                    value={item.year}
                    onChange={(year) => onPatch({ year })}
                  />
                </Field>
              </div>
            )}
          />
        </EditorGroup>

        <EditorGroup id="resume-languages" title={t('languagesGroup')}>
          <Field label={t('sectionTitleLabel')}>
            <TextInput
              value={data.languagesTitle}
              onChange={(languagesTitle) => patch({ languagesTitle })}
            />
          </Field>
          <ListEditor
            {...listLabels}
            addLabel={t('addLanguage')}
            items={data.languages}
            onChange={(languages) => patch({ languages })}
            onCreate={() => ({ ...EMPTY_LANGUAGE })}
            renderItem={(item, onPatch) => (
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label={t('languageName')}>
                  <TextInput
                    value={item.name}
                    onChange={(name) => onPatch({ name })}
                  />
                </Field>
                <Field label={t('languageLevel')}>
                  <TextInput
                    value={item.level}
                    onChange={(level) => onPatch({ level })}
                  />
                </Field>
              </div>
            )}
          />
        </EditorGroup>
    </div>
  );
}
