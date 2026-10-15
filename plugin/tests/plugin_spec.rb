# frozen_string_literal: true

# Picture of the day, run with `trmnlp test` from plugin/. No network: the feed and the metadata call are mocked
# (tests/fixtures). Four views, a landscape and a portrait picture, description on and off, on an OG (1-bit)
# and an X (v2) device.
require 'json'

RSpec.describe 'Wikimedia Commons Picture of the Day' do
  let(:atom) { File.read(File.join(__dir__, 'fixtures', 'potd.atom')) }
  let(:meta) { JSON.parse(File.read(File.join(__dir__, 'fixtures', 'extmetadata.json'))) }
  let(:custom_fields) { { 'mode' => 'today' } }

  # the same record with the picture's size set: wide for a landscape one, tall for a portrait one
  def mocks_for(width, height)
    m = JSON.parse(JSON.generate(meta))
    info = m['query']['pages'].values.first['imageinfo'].first
    info['width'] = width
    info['height'] = height
    { %r{featuredfeed} => { body: atom }, %r{action=query} => { json: m } }
  end

  PICTURES = { 'landscape' => [3000, 2000], 'portrait' => [2000, 3000] }.freeze
  VIEWS = %w[full half_horizontal half_vertical quadrant].freeze
  DEVICES = %w[og_png v2].freeze
  # the same words come out of the fixture on every device
  TITLE = /White teatfish/
  CREDIT = /Diego Delso/
  DESC = /This species of sea cucumber/

  def screen(view, device, shape, show)
    trmnl.render(view:, device:, mocks: mocks_for(*PICTURES[shape]),
                 custom_fields: custom_fields.merge('show_description' => show))
  end

  it_behaves_like 'a publishable recipe' do
    let(:mocks) { mocks_for(3000, 2000) }
  end

  PICTURES.each_key do |shape|
    VIEWS.each do |view|
      DEVICES.each do |device|
        %w[true false].each do |show|
          describe "#{view} #{shape} on #{device}, description #{show == 'true' ? 'on' : 'off'}" do
            let(:page) { screen(view, device, shape, show) }

            it 'never crops the picture' do
              fit = page.evaluate("getComputedStyle(document.querySelector('img.image')).objectFit")
              expect(fit).to eq('contain')
            end

            it 'shows or leaves out the description as set' do
              page.has_css?('img.image') # wait for the page
              if show == 'true' && %w[full half_horizontal].include?(view)
                expect(page).to have_text(DESC)
              elsif show == 'false'
                expect(page).to have_no_text(DESC)
              end
            end

            it 'shows title and credit where there is room for text' do
              next if view == 'quadrant'

              expect(page).to have_text(TITLE)
              expect(page).to have_text(CREDIT)
            end

            it 'has no overflow and no page errors' do
              expect(page).to have_no_overflow
              expect(page).to have_no_problems
            end

            it 'sets the description in a native framework size, never scaled' do
              page.has_css?('img.image') # wait for the page
              next unless show == 'true'

              # a probe with the same class, outside the description box, is what "native" means on this device
              r = page.evaluate(<<~JS)
                (() => {
                  const d = document.querySelector('.description');
                  if (!d) return null;
                  const probe = document.createElement('span');
                  probe.className = 'description';
                  document.querySelector('.view').appendChild(probe);
                  const native = getComputedStyle(probe).fontSize;
                  probe.remove();
                  const chain = [];
                  for (let e = d; e; e = e.parentElement) if (e.style.fontSize || e.style.transform || e.hasAttribute('data-content-limiter')) chain.push(e.className);
                  const b = d.getBoundingClientRect();
                  return { size: getComputedStyle(d).fontSize, native, chain, whole: Number.isInteger(b.x) ? '' : String(b.x) };
                })()
              JS
              next if r.nil? # quadrant and half_vertical may have no room for it

              expect(r['size']).to eq(r['native'])
              expect(r['chain']).to eq([])
              # a column edge on a half pixel in x dithers the glyphs to hatching on 1-bit (seen with a 38cqw column)
              expect(r['whole']).to eq('') if device == 'og_png'
            end

            if device == 'og_png'
              it 'draws no grey: classes, inline colours, computed text, background (pill) and rule colours' do
                html = page.html
                expect(html).not_to match(/\b(text|bg|label|border--[hv])-(-)?(gray|grey|[1-7][05])\b|--gray|--grey/)
                expect(html).not_to match(/style="[^"]*(color|background)[^"]*#(?!000\b|000000|fff\b|ffffff)/i)
                greys = page.evaluate(<<~JS)
                  [...document.querySelectorAll('body *')].flatMap((e) => {
                    const c = getComputedStyle(e), ok = (v) => /^(rgb\\(0, 0, 0\\)|rgb\\(255, 255, 255\\)|rgba\\(0, 0, 0, 0\\))$/.test(v);
                    const bad = [];
                    if (e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && !ok(c.color)) bad.push(e.className + ' color ' + c.color);
                    if (!ok(c.backgroundColor) && c.backgroundColor !== 'rgb(255, 255, 255)') bad.push(e.className + ' background ' + c.backgroundColor);
                    for (const s of ['Top', 'Right', 'Bottom', 'Left']) if (parseFloat(c['border' + s + 'Width']) > 0 && !ok(c['border' + s + 'Color'])) bad.push(e.className + ' border ' + c['border' + s + 'Color']);
                    return bad;
                  })
                JS
                expect(greys).to eq([])
              end
            end
          end
        end
      end
    end
  end

  it 'draws a rule between the picture and the text of a landscape picture' do
    page = screen('full', 'og_png', 'landscape', 'true')
    expect(page).to have_css('[data-rule=picture]')
  end
end
