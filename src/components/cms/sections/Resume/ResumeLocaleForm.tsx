'use client';

import { useTranslations } from 'next-intl';
import { EditorGroup } from '@/components/cms/shared/EditorBody';
import type {
  ResumeContact,
  ResumeContactIcon,
  ResumeData,
  ResumeEducation,
  ResumeExperience,
  ResumeLanguage,
  ResumeProject,
  ResumeSkillGroup,
} from '@/libs/resume/types';
import { Field, ListEditor, TextArea, TextInput } from './ResumeFields';

const CONTACT_ICONS: ResumeContactIcon[] = [
  'location',
  'phone',
  'email',
  'github',
  'linkedin',
  'website',
  'document',
];

const EMPTY_CONTACT: ResumeContact = { icon: 'website', text: '' };
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
      <EditorGroup title={t('headerGroup')}>
        <Field label={t('nameLabel')}>
          <TextInput value={data.name} onChange={(v) => patch({ name: v })} />
        </Field>
        <Field label={t('headlineLabel')}>
          <TextInput value={data.title} onChange={(v) => patch({ title: v })} />
        </Field>
        <ListEditor
          {...listLabels}
          addLabel={t('addContact')}
          items={data.contacts}
          onChange={(contacts) => patch({ contacts })}
          onCreate={() => ({ ...EMPTY_CONTACT })}
          renderItem={(item, onPatch) => (
            <div className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
                <label className="block">
                  <span className="mb-1 block text-xs text-text-muted">
                    {t('iconLabel')}
                  </span>
                  <select
                    value={item.icon}
                    onChange={(e) =>
                      onPatch({
                        icon: e.target.value as ResumeContactIcon,
                      })
                    }
                    className="w-full rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-sm text-text-main outline-none focus:border-accent-violet"
                  >
                    {CONTACT_ICONS.map((icon) => (
                      <option key={icon} value={icon}>
                        {icon}
                      </option>
                    ))}
                  </select>
                </label>
                <Field label={t('contactText')}>
                  <TextInput
                    value={item.text}
                    onChange={(text) => onPatch({ text })}
                  />
                </Field>
              </div>
              <Field label={t('contactHref')} hint={t('contactHrefHint')}>
                <TextInput
                  mono
                  value={item.href ?? ''}
                  onChange={(href) => onPatch({ href })}
                  placeholder="https://… / mailto:… / tel:…"
                />
              </Field>
            </div>
          )}
        />
      </EditorGroup>

      <EditorGroup title={t('summaryGroup')}>
        <Field label={t('sectionTitleLabel')}>
          <TextInput
            value={data.summaryTitle}
            onChange={(summaryTitle) => patch({ summaryTitle })}
          />
        </Field>
        <Field label={t('summaryLabel')} hint={t('richHint')}>
          <TextArea
            rows={5}
            value={data.summaryHtml}
            onChange={(summaryHtml) => patch({ summaryHtml })}
          />
        </Field>
      </EditorGroup>

      <EditorGroup title={t('skillsGroup')}>
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

      <EditorGroup title={t('experienceGroup')}>
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
              <Field label={t('bulletsLabel')} hint={t('richHintLines')}>
                <TextArea
                  rows={4}
                  value={item.bullets.join('\n')}
                  onChange={(v) =>
                    onPatch({ bullets: v.split('\n').map((b) => b.trim()) })
                  }
                />
              </Field>
            </div>
          )}
        />
      </EditorGroup>

      <EditorGroup title={t('projectsGroup')}>
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
              <Field label={t('bulletsLabel')} hint={t('richHintLines')}>
                <TextArea
                  rows={3}
                  value={item.bullets.join('\n')}
                  onChange={(v) =>
                    onPatch({ bullets: v.split('\n').map((b) => b.trim()) })
                  }
                />
              </Field>
            </div>
          )}
        />
      </EditorGroup>

      <div className="grid gap-6 md:grid-cols-2">
        <EditorGroup title={t('educationGroup')}>
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

        <EditorGroup title={t('languagesGroup')}>
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

      <EditorGroup title={t('footerGroup')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('continuationLabel')}>
            <TextInput
              value={data.continuationTitle}
              onChange={(continuationTitle) => patch({ continuationTitle })}
            />
          </Field>
          <Field label={t('footerLeftLabel')}>
            <TextInput
              value={data.footerLeft}
              onChange={(footerLeft) => patch({ footerLeft })}
            />
          </Field>
          <Field label={t('pageOneLabel')}>
            <TextInput
              value={data.pageOneLabel}
              onChange={(pageOneLabel) => patch({ pageOneLabel })}
            />
          </Field>
          <Field label={t('pageTwoLabel')}>
            <TextInput
              value={data.pageTwoLabel}
              onChange={(pageTwoLabel) => patch({ pageTwoLabel })}
            />
          </Field>
        </div>
      </EditorGroup>
    </div>
  );
}
